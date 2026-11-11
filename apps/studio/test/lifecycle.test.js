/**
 * Runtime lifecycle: quitting mid-probe, and what "the runtime is gone" may mean.
 *
 * Tests marked "real runtime" drive the actual dsh process. The rest inject a scripted
 * client and a scripted process table to force outcomes a real runtime cannot produce on
 * demand (close throwing, close hanging, the OS refusing to answer). They are labelled so
 * they are never mistaken for integration proof. The real reclamation paths are covered
 * in processes.test.js against live child processes.
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

const IDENTITY = { pid: 4242, creationMs: 111, capturedAt: new Date().toISOString(), source: 'parent-and-bin' }

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

/** A table whose inspect() walks a scripted sequence; list() is unused when capture is injected. */
function scriptedTable(sequence) {
  let index = 0
  return {
    async list() {
      return { ok: true, processes: [], error: null, durationMs: 1 }
    },
    async listChildren() {
      return { ok: true, processes: [], error: null, durationMs: 1 }
    },
    async inspect(pid) {
      const step = sequence[Math.min(index, sequence.length - 1)]
      index += 1
      if (step.error) return { found: false, process: null, error: step.error, durationMs: 1 }
      if (!step.found) return { found: false, process: null, error: null, durationMs: 1 }
      return {
        found: true,
        process: { pid, parentPid: 1, name: 'node.exe', creationMs: step.creationMs ?? IDENTITY.creationMs, commandLine: 'node dsh.js' },
        error: null,
        durationMs: 1,
      }
    },
  }
}

const captured = (identity = IDENTITY) => async () => ({ status: 'captured', identity, error: null, candidates: 1, durationMs: 1 })
const captureFailed = (error) => async () => ({ status: 'failed', identity: null, error, candidates: 0, durationMs: 1 })
const captureAbsent = async () => ({ status: 'absent', identity: null, error: null, candidates: 0, durationMs: 1 })

const termination = (overrides = {}) => async () => ({
  attempted: true,
  killedPids: [],
  skippedPids: [],
  remainingPids: [],
  succeeded: false,
  error: null,
  durationMs: 5,
  deadlineHit: false,
  ...overrides,
})

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
  assert.equal(result.teardown, null)
  assert.ok(events.some((entry) => entry.event === 'dsh.shutdown'))
})

test('quitting during the handshake reaps the runtime (real runtime)', async () => {
  const { service, events } = harness()
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(service.isChecking(), true)

  const result = await service.shutdown('app-quit')
  const final = await inflight

  assert.equal(result.completed, true, JSON.stringify(result.teardown))
  assert.equal(result.confirmedGone, true)
  assert.equal(result.teardown.closed, true)
  assert.equal(result.teardown.processCheckStatus, 'ABSENT')
  assert.equal(result.teardown.processAbsent, true)
  assert.ok(Number.isInteger(result.teardown.runtimePid), 'the runtime identity must be pinned')

  assert.equal(final.status, 'UNKNOWN')
  assert.equal(final.detail.code, 'STOPPED')

  const logged = lastShutdown(events)
  assert.ok(logged)
  for (const key of [
    'completed', 'confirmedGone', 'timedOut', 'teardownAttempted', 'closeSucceeded',
    'processCheckStatus', 'processAbsent', 'runtimePid', 'identitySource',
    'forcedTerminationAttempted', 'exitCode', 'error', 'durationMs',
  ]) {
    assert.ok(key in logged.fields, 'shutdown log is missing ' + key)
  }
})

test('repeated quit requests join one shutdown and one close', async () => {
  const { service, events } = harness()
  void service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 200))
  const first = service.shutdown('app-quit')
  const second = service.shutdown('app-quit')
  assert.equal(first, second)
  await first
  assert.equal(events.filter((entry) => entry.event === 'dsh.shutdown').length, 1)
})

test('a probe requested after shutdown is refused and spawns nothing', async () => {
  const { service, events } = harness()
  await service.shutdown('app-quit')
  const before = events.filter((entry) => entry.event === 'dsh.probe.start').length
  const state = await service.check('manual')
  assert.equal(state.status, 'UNKNOWN')
  assert.equal(state.detail.code, 'STOPPED')
  assert.equal(events.filter((entry) => entry.event === 'dsh.probe.start').length, before)
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
// Completion semantics.
// ---------------------------------------------------------------------------

test('close ok + OS ABSENT → completed', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: false }]),
      terminateIdentity: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.closed, true)
  assert.equal(result.teardown.processCheckStatus, 'ABSENT')
  assert.equal(result.completed, true)
  assert.equal(result.confirmedGone, true)
})

test('close ok + OS PRESENT → fallback reclaims, but the clean path still failed', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: true }, { found: false }]),
      terminateIdentity: termination({ succeeded: true, killedPids: [IDENTITY.pid], remainingPids: [] }),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.firstCheckStatus, 'PRESENT')
  assert.equal(result.teardown.forcedTerminationSucceeded, true)
  assert.equal(result.teardown.processAbsent, true)
  assert.equal(result.confirmedGone, true)
  assert.equal(result.completed, false, 'close alone did not suffice, so this was not a clean exit')
})

test('close ok + OS fails to answer → not completed', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ error: 'wmi down' }]),
      terminateIdentity: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.processCheckStatus, 'FAILED')
  assert.equal(result.teardown.processAbsent, null)
  assert.equal(result.completed, false)
  assert.equal(result.confirmedGone, false, 'an inconclusive check must not read as gone')
  assert.match(String(result.teardown.error), /wmi down/)
})

test('close throws + OS ABSENT → close success is not faked', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => { throw new Error('close blew up') } }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: false }]),
      terminateIdentity: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.closed, false)
  assert.match(String(result.teardown.closeError), /close blew up/)
  assert.equal(result.completed, false)
})

test('close throws + OS PRESENT → fallback reclaims, clean path still failed', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => { throw new Error('close blew up') } }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: true }, { found: false }]),
      terminateIdentity: termination({ succeeded: true, killedPids: [IDENTITY.pid] }),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.forcedTerminationSucceeded, true)
  assert.equal(result.confirmedGone, true)
  assert.equal(result.completed, false)
})

test('forced termination fails → residual PID kept, nothing claims success', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: true }, { found: true }]),
      terminateIdentity: termination({ succeeded: false, remainingPids: [IDENTITY.pid], error: 'taskkill refused' }),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.forcedTerminationAttempted, true)
  assert.equal(result.teardown.forcedTerminationSucceeded, false)
  assert.deepEqual(result.teardown.remainingPids, [IDENTITY.pid])
  assert.equal(result.completed, false)
  assert.equal(result.confirmedGone, false)
})

test('identity capture failure is unknown, not success', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      captureIdentity: captureFailed('ambiguous runtime identity'),
      processTable: scriptedTable([{ found: false }]),
      terminateIdentity: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.processAbsent, null)
  assert.equal(result.completed, false)
  assert.match(String(result.teardown.error), /ambiguous runtime identity/)
})

test('a recycled PID is treated as ours being gone, not as a process to kill', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: async () => {} }),
      captureIdentity: captured(),
      // The PID now belongs to a different process (different creation time).
      processTable: scriptedTable([{ found: true, creationMs: IDENTITY.creationMs + 5000 }]),
      terminateIdentity: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  await inflight
  assert.equal(result.teardown.processCheckStatus, 'ABSENT')
  assert.equal(result.teardown.forcedTerminationAttempted, false, 'a recycled PID must never be killed')
})

test('close never resolves → shutdown is bounded by its own budget', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ close: () => new Promise(() => {}) }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: false }]),
      terminateIdentity: termination(),
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

test('a stop before the handshake answers still closes the runtime', async () => {
  const { service } = harness({
    probeDeps: {
      clientFactory: scriptedClient({ initialize: () => new Promise(() => {}), close: async () => {} }),
      captureIdentity: captured(),
      processTable: scriptedTable([{ found: false }]),
      terminateIdentity: termination(),
    },
  })
  const inflight = service.check('manual')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const result = await service.shutdown('app-quit')
  const final = await inflight
  assert.equal(result.completed, true)
  assert.equal(final.detail.code, 'STOPPED')
})
