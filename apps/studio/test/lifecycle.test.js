/**
 * Runtime lifecycle: what happens to the DSH process when the app quits mid-probe, and
 * what "the runtime is gone" is allowed to mean.
 *
 * Tests marked "real runtime" drive the actual dsh process. The rest inject a scripted
 * client and a scripted process table to force outcomes a real runtime cannot produce on
 * demand (close throwing, close hanging, the OS table refusing to answer). They are
 * labelled so they are never mistaken for integration proof.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DshConnectionService } = require('../dist/main/dsh/service.js')
const { runProbe } = require('../dist/main/dsh/probe.js')
const { resolveDshEntry } = require('../dist/main/dsh/locate.js')
const { DEFAULT_CONFIG } = require('../dist/main/config.js')

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lifecycle-'))
  const events = []
  const logger = {
    path: path.join(dir, 'studio.log'),
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
  }
  const config = structuredClone(DEFAULT_CONFIG)
  Object.assign(config.dsh, options.dsh ?? {})
  const service = new DshConnectionService({
    logger,
    userDataDir: dir,
    readConfig: () => config,
    configRecovered: false,
    configRecoveryNote: null,
    probeDeps: options.probeDeps,
  })
  return { service, events, dir, config }
}

const finding = (status, pids = [], error = null) => () => ({
  status,
  pids,
  error,
  checkedAt: new Date().toISOString(),
})

const absent = finding('ABSENT')
const present = (pids, error = null) => finding('PRESENT', pids, error)
const failed = (error) => finding('FAILED', [], error)

const termination = (overrides = {}) => async () => ({
  attempted: true,
  killedPids: [],
  skippedPids: [],
  remainingPids: [],
  succeeded: false,
  error: null,
  durationMs: 5,
  ...overrides,
})

/** A client whose behaviour is scripted; the async iterator fails like a dead transport. */
function scriptedClient({ initialize, close, exitCodeMessage }) {
  return () => ({
    start() {},
    initialize: initialize ?? (() => new Promise(() => {})),
    close,
    subscribe: () => ({
      next: () => new Promise(() => {}),
      close() {},
      async *[Symbol.asyncIterator]() {
        throw new Error(exitCodeMessage ?? 'dsh profile "sdk": DeepSeek Harness runtime exited\nexit code: 7')
      },
    }),
  })
}

const lastShutdown = (events) => [...events].reverse().find((entry) => entry.event === 'dsh.shutdown.result')

test('shutdown with no probe in flight completes immediately', async () => {
  const { service, events } = harness()
  const result = await service.shutdown('app-quit')
  assert.equal(result.completed, true)
  assert.equal(result.confirmedGone, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.teardown, null)
  assert.ok(events.some((entry) => entry.event === 'dsh.shutdown'))
})

test('quitting during the handshake reaps the runtime (real runtime)', async () => {
  const { service, events } = harness()
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(service.isChecking(), true, 'the probe should still be running')

  const result = await service.shutdown('app-quit')
  const final = await inflight

  assert.equal(result.completed, true, JSON.stringify(result.teardown))
  assert.equal(result.confirmedGone, true)
  assert.equal(result.teardown.closed, true)
  assert.equal(result.teardown.processCheckStatus, 'ABSENT')
  assert.equal(result.teardown.processAbsent, true)
  assert.equal(result.teardown.completed, true)
  assert.ok(Number.isInteger(result.teardown.exitCode), 'exit code is recorded as a diagnostic')

  assert.equal(final.status, 'UNKNOWN')
  assert.equal(final.detail.code, 'STOPPED')

  const logged = lastShutdown(events)
  assert.ok(logged, 'shutdown result must be logged')
  for (const key of ['completed', 'confirmedGone', 'timedOut', 'closeSucceeded', 'processCheckStatus', 'processAbsent', 'forcedTerminationAttempted', 'exitCode', 'error', 'durationMs']) {
    assert.ok(key in logged.fields, 'shutdown log is missing ' + key)
  }
})

test('repeated quit requests join one shutdown and one close', async () => {
  const { service, events } = harness()
  void service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 200))

  const first = service.shutdown('app-quit')
  const second = service.shutdown('app-quit')
  assert.equal(first, second, 'the second quit must join the first shutdown')
  const result = await first
  assert.equal(result.completed, true)
  assert.equal(events.filter((entry) => entry.event === 'dsh.shutdown').length, 1)
})

test('a probe requested after shutdown is refused and spawns nothing', async () => {
  const { service, events } = harness()
  await service.shutdown('app-quit')
  const startsBefore = events.filter((entry) => entry.event === 'dsh.probe.start').length
  const state = await service.check('manual')
  assert.equal(state.status, 'UNKNOWN')
  assert.equal(state.detail.code, 'STOPPED')
  assert.equal(events.filter((entry) => entry.event === 'dsh.probe.start').length, startsBefore)
  assert.ok(events.some((entry) => entry.event === 'dsh.probe.refused'))
})

test('stop() is idempotent and reports the same teardown twice (real runtime)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-handle-'))
  const handle = runProbe({
    dshHome: home,
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 60000,
    cwd: home,
    entry: resolveDshEntry(null),
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  handle.stop('test')
  handle.stop('test-again')
  const a = await handle.stopped()
  const b = await handle.stopped()
  assert.equal(a, b)
  assert.equal(a.closed, true)
  assert.equal(a.completed, true)
  await handle.done
})

// ---------------------------------------------------------------------------
// Completion semantics. The matrix the review asked for, one case at a time.
// ---------------------------------------------------------------------------

test('close ok + OS ABSENT → completed', async () => {
  const { service } = harness({
    probeDeps: { clientFactory: scriptedClient({ close: async () => {} }), processProbe: absent, terminate: termination() },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.closed, true)
  assert.equal(result.teardown.processAbsent, true)
  assert.equal(result.completed, true)
  assert.equal(result.confirmedGone, true)
})

test('close ok + OS PRESENT → not completed, and the fallback runs', async () => {
  let terminated = 0
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      processProbe: present([4242]),
      terminate: async () => {
        terminated += 1
        return { attempted: true, killedPids: [4242], skippedPids: [], remainingPids: [], succeeded: true, error: null, durationMs: 3 }
      },
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(terminated, 1, 'the fallback must run when the process is still there')
  assert.equal(result.teardown.forcedTerminationAttempted, true)
})

test('close ok + OS FAILED → not completed (could not determine is not success)', async () => {
  const { service } = harness({
    probeDeps: { clientFactory: scriptedClient({ close: async () => {} }), processProbe: failed('wmi down'), terminate: termination() },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.processAbsent, null)
  assert.equal(result.teardown.completed, false)
  assert.equal(result.completed, false)
  assert.equal(result.confirmedGone, false, 'an inconclusive check must not read as gone')
  assert.match(String(result.teardown.error), /wmi down/)
})

test('close throws + OS ABSENT → close success is not faked', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => { throw new Error('close blew up') } }),
      processProbe: absent,
      terminate: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.closed, false, 'a throwing close must not be recorded as success')
  assert.match(String(result.teardown.closeError), /close blew up/)
  assert.equal(result.completed, false)
})

test('close throws + OS PRESENT → fallback reclaims, but the clean path still failed', async () => {
  // The table has to actually change after the fallback: PRESENT before, ABSENT after.
  // A probe that always answers PRESENT would only prove the code kept asking.
  let checks = 0
  const changingProbe = () => {
    checks += 1
    return { status: checks === 1 ? 'PRESENT' : 'ABSENT', pids: checks === 1 ? [777] : [], error: null, checkedAt: new Date().toISOString() }
  }
  const { service, events } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => { throw new Error('close blew up') } }),
      processProbe: changingProbe,
      terminate: async () => ({ attempted: true, killedPids: [777], skippedPids: [], remainingPids: [], succeeded: true, error: null, durationMs: 4 }),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.forcedTerminationSucceeded, true)
  assert.equal(result.confirmedGone, true, 'the process is gone, so the safety property holds')
  assert.equal(result.completed, false, 'but close still failed, so the clean path did not')
  assert.equal(lastShutdown(events).fields.forcedTerminationSucceeded, true)
})

test('close never resolves + OS PRESENT → bounded shutdown, then fallback', async () => {
  let terminated = 0
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: () => new Promise(() => {}) }),
      processProbe: present([888]),
      terminate: async () => {
        terminated += 1
        return { attempted: true, killedPids: [888], skippedPids: [], remainingPids: [], succeeded: true, error: null, durationMs: 4 }
      },
    },
  })
  void service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const started = Date.now()
  const result = await service.shutdown('app-quit', 300)
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.equal(result.completed, false)
  assert.ok(elapsed < 5000, 'shutdown must not wait for the SDK bound: ' + elapsed)
})

test('forced termination fails → residual PIDs are kept and nothing claims success', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      processProbe: present([999]),
      terminate: async () => ({ attempted: true, killedPids: [], skippedPids: [999], remainingPids: [999], succeeded: false, error: 'taskkill refused', durationMs: 4 }),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.forcedTerminationAttempted, true)
  assert.equal(result.teardown.forcedTerminationSucceeded, false)
  assert.deepEqual(result.teardown.remainingPids, [999])
  assert.equal(result.completed, false)
  assert.equal(result.confirmedGone, false)
})

test('a stop before the handshake answers still closes the runtime', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ initialize: () => new Promise(() => {}), close: async () => {} }),
      processProbe: absent,
      terminate: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  const final = await inflight
  assert.equal(result.completed, true)
  assert.equal(result.teardown.closed, true)
  assert.equal(final.detail.code, 'STOPPED')
})
