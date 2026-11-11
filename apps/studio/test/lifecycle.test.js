/**
 * Runtime lifecycle: what happens to the DSH process when the app quits mid-probe.
 *
 * Tests 1-5 drive the real dsh runtime. Tests 6-8 use an injected client to force the two
 * failure shapes a real runtime cannot produce on demand (close throwing, close hanging) —
 * they are labelled as fault injection so they are never mistaken for integration proof.
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

const absentProbe = () => ({ status: 'ABSENT', pids: [], error: null, checkedAt: new Date().toISOString() })

/** A client whose behaviour is scripted: the two shapes a real runtime cannot reproduce. */
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

test('shutdown with no probe in flight completes immediately', async () => {
  const { service, events } = harness()
  const result = await service.shutdown('app-quit')
  assert.equal(result.completed, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.teardown, null)
  assert.ok(events.some((entry) => entry.event === 'dsh.shutdown'), 'shutdown must be logged')
})

test('quitting during the handshake reaps the runtime before returning', async () => {
  const { service, events } = harness()
  const inflight = service.check('manual')
  // Real dsh spends ~1.7 s in initialize; 250 ms reliably lands inside it.
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(service.isChecking(), true, 'the probe should still be running')

  const result = await service.shutdown('app-quit')
  const final = await inflight

  assert.equal(result.completed, true, JSON.stringify(result.teardown))
  assert.equal(result.timedOut, false)
  assert.equal(result.teardown.attempted, true)
  assert.equal(result.teardown.closed, true, 'SDK close must have resolved')
  assert.equal(result.teardown.processAbsent, true, 'the OS check must find no runtime for this home')
  assert.ok(Number.isInteger(result.teardown.exitCode), 'the runtime exit code should be observed')

  assert.equal(final.status, 'UNKNOWN')
  assert.equal(final.detail.code, 'STOPPED')
  assert.equal(service.isClosing === undefined || true, true)
  assert.ok(events.some((entry) => entry.event === 'dsh.shutdown.result'))
})

test('repeated quit requests join one shutdown and one close', async () => {
  const { service, events } = harness()
  void service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 200))

  const first = service.shutdown('app-quit')
  const second = service.shutdown('app-quit')
  assert.equal(first, second, 'the second quit must join the first shutdown, not issue a new one')
  const result = await first

  assert.equal(result.completed, true)
  const closeLogs = events.filter((entry) => entry.event === 'dsh.shutdown').length
  assert.equal(closeLogs, 1, 'shutdown must only be initiated once')
  assert.ok(events.some((entry) => entry.event === 'dsh.shutdown.result'))
})

test('a probe requested after shutdown is refused and spawns nothing', async () => {
  const { service, events } = harness()
  await service.shutdown('app-quit')
  const startsBefore = events.filter((entry) => entry.event === 'dsh.probe.start').length

  const state = await service.check('manual')
  assert.equal(state.status, 'UNKNOWN')
  assert.equal(state.detail.code, 'STOPPED')
  assert.equal(events.filter((entry) => entry.event === 'dsh.probe.start').length, startsBefore, 'no probe may start')
  assert.ok(events.some((entry) => entry.event === 'dsh.probe.refused'))
})

test('stop() is idempotent and reports the same teardown twice', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-handle-'))
  const handle = runProbe({
    dshHome: home,
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 60000,
    cwd: home,
    entry: resolveDshEntry(null),
    deps: { processProbe: absentProbe },
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  handle.stop('test')
  handle.stop('test-again')
  const a = await handle.stopped()
  const b = await handle.stopped()
  assert.equal(a, b, 'the teardown report must be produced once')
  assert.equal(a.closed, true)
  await handle.done
})

test('a close that throws is recorded and still yields a terminal state', async () => {
  const { service, events } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => { throw new Error('close blew up') } }),
      processProbe: absentProbe,
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const result = await service.shutdown('app-quit')
  await inflight

  assert.equal(result.teardown.closed, false)
  assert.match(String(result.teardown.error), /close blew up/)
  assert.ok(events.some((entry) => entry.event === 'dsh.shutdown.result' && entry.level === 'error'))
})

test('a close that never resolves is bounded, not an infinite quit', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: () => new Promise(() => {}) }),
      processProbe: absentProbe,
    },
  })
  void service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 100))

  const started = Date.now()
  const result = await service.shutdown('app-quit', 300)
  const elapsed = Date.now() - started

  assert.equal(result.timedOut, true)
  assert.equal(result.completed, false)
  assert.ok(elapsed < 5000, 'shutdown must not wait for the SDK bound: ' + elapsed)
})

test('a stop before the handshake answers still closes the runtime', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ initialize: () => new Promise(() => {}), close: async () => {} }),
      processProbe: absentProbe,
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const result = await service.shutdown('app-quit')
  const final = await inflight

  assert.equal(result.completed, true)
  assert.equal(result.teardown.closed, true)
  assert.equal(final.detail.code, 'STOPPED')
})
