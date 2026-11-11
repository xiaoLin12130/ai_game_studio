/**
 * Runtime shutdown races, forced deterministically with deferred promises.
 *
 * The interesting cases cannot be produced by a real runtime on demand: a close that is
 * started by a lease release and then raced by shutdownAll, a close that never settles, a
 * close that rejects. All three used to be mishandled — the first reported a live close as
 * failed, the second could mark a runtime closed when it was not.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { RuntimeSupervisor } = require('../dist/main/runtime/supervisor.js')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ENTRY = { kind: 'bundled', bin: null, displayPath: 'dsh', version: '0.2.1', problem: null }

/** A client whose close() settles only when the test says so. */
function makeClient(control) {
  return {
    start() {},
    async initialize() {
      return { serverInfo: { name: 'stub', version: '0' } }
    },
    close() {
      control.closeCalls += 1
      if (control.mode === 'hang') return new Promise(() => {})
      if (control.mode === 'reject') return Promise.reject(new Error(control.message ?? 'close blew up'))
      if (control.mode === 'resolve') return Promise.resolve()
      return control.gate.promise
    },
    subscribe() {
      return { next: () => new Promise(() => {}), close() {}, [Symbol.asyncIterator]: async function* () {} }
    },
    async prompt() {
      return 'id'
    },
    async resumeSession() {},
  }
}

function makeSupervisor(t, control) {
  const events = []
  const supervisor = new RuntimeSupervisor({
    logger: {
      info: (event, fields) => events.push({ level: 'info', event, fields }),
      warn: (event, fields) => events.push({ level: 'warn', event, fields }),
      error: (event, fields) => events.push({ level: 'error', event, fields }),
    },
    dshHome: 'dsh-home',
    profile: 'sdk',
    provider: 'commandcode',
    model: 'm',
    cwd: 'workspace',
    entry: ENTRY,
    closeTimeoutMs: control.closeTimeoutMs ?? 300,
    clientFactory: () => makeClient(control),
  })
  t.after(async () => {
    control.mode = 'resolve'
    control.gate.resolve()
    await supervisor.shutdownAll('test-end').catch(() => {})
  })
  return { supervisor, events }
}

test('shutdownAll waits for a close that a lease release already started', async (t) => {
  const control = { closeCalls: 0, mode: 'gate', gate: deferred(), closeTimeoutMs: 300 }
  const { supervisor } = makeSupervisor(t, control)
  const lease = await supervisor.acquire({ taskId: 'task-1', isolation: 'writable' })

  // The lease release starts the close; it does not finish yet.
  const releasing = lease.release('interrupted')
  await new Promise((r) => setImmediate(r))
  assert.equal(control.closeCalls, 1)

  let shutdownSettled = false
  const shutting = supervisor.shutdownAll('app-quit').then((result) => {
    shutdownSettled = true
    return result
  })

  // While the close is in flight, shutdown must NOT have concluded failure.
  await new Promise((r) => setImmediate(r))
  assert.equal(shutdownSettled, false, 'shutdown must wait for the in-flight close, not assume failure')

  control.gate.resolve()
  const [releaseResult, shutdownResult] = await Promise.all([releasing, shutting])
  assert.equal(control.closeCalls, 1, 'the SDK close must run exactly once')
  assert.deepEqual(shutdownResult, { closed: ['rt-001'], failed: [] })
  assert.equal(releaseResult, undefined)
})

test('two concurrent close requests share one SDK close', async (t) => {
  const control = { closeCalls: 0, mode: 'gate', gate: deferred(), closeTimeoutMs: 300 }
  const { supervisor } = makeSupervisor(t, control)
  const lease = await supervisor.acquire({ taskId: 'task-1', isolation: 'writable' })

  const first = lease.release('one')
  const second = supervisor.shutdownAll('two')
  await new Promise((r) => setImmediate(r))
  assert.equal(control.closeCalls, 1, 'a second request must join the first close')

  control.gate.resolve()
  const [, shutdownResult] = await Promise.all([first, second])
  assert.deepEqual(shutdownResult.failed, [])
})

test('a close that never settles is a failure, not a success', async (t) => {
  const control = { closeCalls: 0, mode: 'hang', gate: deferred(), closeTimeoutMs: 120 }
  const { supervisor, events } = makeSupervisor(t, control)
  const lease = await supervisor.acquire({ taskId: 'task-1', isolation: 'writable' })

  const started = Date.now()
  await lease.release('stop')
  const elapsed = Date.now() - started

  assert.ok(elapsed >= 100, 'the close must be bounded: ' + elapsed + 'ms')
  const snapshot = supervisor.snapshot()
  assert.equal(snapshot.length, 1, 'an unclosed runtime must stay observable')
  assert.equal(snapshot[0].state, 'failed')
  assert.ok(
    events.some((entry) => entry.event === 'runtime.close.failed' && entry.fields.timedOut === true),
    'the timeout must be logged as a failure',
  )
})

test('a close that rejects is kept and reported, not silently dropped', async (t) => {
  const control = { closeCalls: 0, mode: 'reject', message: 'dispose ladder failed', gate: deferred(), closeTimeoutMs: 300 }
  const { supervisor } = makeSupervisor(t, control)
  const lease = await supervisor.acquire({ taskId: 'task-1', isolation: 'writable' })
  await lease.release('stop')

  const snapshot = supervisor.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].state, 'failed')

  const result = await supervisor.shutdownAll('app-quit')
  assert.deepEqual(result.closed, [])
  assert.deepEqual(result.failed, ['rt-001'], 'the shutdown must report the runtime as failed')
})

test('a clean close disappears from management and is reported closed', async (t) => {
  const control = { closeCalls: 0, mode: 'resolve', gate: deferred(), closeTimeoutMs: 300 }
  const { supervisor } = makeSupervisor(t, control)
  const lease = await supervisor.acquire({ taskId: 'task-1', isolation: 'writable' })
  await lease.release('completed')
  assert.equal(supervisor.snapshot().length, 0)
})

test('dispose reports ok only when every runtime actually closed', async (t) => {
  const { TaskService } = require('../dist/main/tasks/service.js')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dispose-'))
  const events = []
  const logger = {
    info: (event, fields) => events.push({ event, fields }),
    warn: (event, fields) => events.push({ event, fields }),
    error: (event, fields) => events.push({ event, fields }),
  }
  const control = { closeCalls: 0, mode: 'reject', message: 'cannot close', gate: deferred(), closeTimeoutMs: 300 }
  const supervisor = new RuntimeSupervisor({
    logger,
    dshHome: dir,
    profile: 'sdk',
    provider: 'commandcode',
    model: 'm',
    cwd: dir,
    entry: ENTRY,
    closeTimeoutMs: control.closeTimeoutMs ?? 300,
    clientFactory: () => makeClient(control),
  })
  const service = new TaskService({
    logger,
    userDataDir: dir,
    dshHome: dir,
    profile: 'sdk',
    provider: 'commandcode',
    model: 'm',
    cwd: dir,
    supervisor,
  })
  t.after(() => { try { service.store.close() } catch {} })

  const lease = await supervisor.acquire({ taskId: 'task-1', isolation: 'writable' })
  void lease // the runtime is live when dispose runs

  const result = await service.dispose('app-quit')
  assert.equal(result.ok, false)
  assert.deepEqual(result.failed, ['rt-001'])
  assert.ok(events.some((entry) => entry.event === 'task.service.dispose.failed'), 'the failure must be logged, not swallowed')
})
