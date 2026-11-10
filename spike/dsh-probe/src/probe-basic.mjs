/**
 * Probe A — high-level path that Studio will actually use.
 *
 * Goal: prove that Studio code can (1) start the real DSH runtime through the
 * official SDK, (2) run one real prompt on a session, (3) observe live
 * event/status transitions, and (4) close the runtime so the OS process really
 * exits.
 *
 * Nothing here is mocked: the child process is the shipped `dsh --profile sdk`
 * runtime resolved by the SDK package itself.
 */
import fs from 'node:fs'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { listChildProcesses, waitForNoDshChild, runtimeVersionFacts, clearStaleProfileLock } from './lib/proc.mjs'
import { EXIT, detectModelBlocker } from './lib/outcome.mjs'

const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'
const PROMPT = process.env.PROBE_PROMPT ?? 'Reply with exactly one word: PONG'

const ev = createEvidence('a-basic-run')
const summary = { probe: 'A-basic-run', startedAt: new Date().toISOString(), runtime: runtimeVersionFacts() }

const dshHome = p('tmp', 'dsh-home')
const workspace = p('tmp', 'workspace')
fs.mkdirSync(dshHome, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })

summary.lockRecovery = clearStaleProfileLock(dshHome)
if (summary.lockRecovery.cleared) step('cleared stale profile lock', { stalePid: summary.lockRecovery.stalePid })

ev.append('probe.start', { dshHome, workspace, provider: PROVIDER, model: MODEL, prompt: PROMPT })
step('starting runtime via official SDK', { provider: PROVIDER, model: MODEL })

const harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome,
  cwd: workspace,
  provider: PROVIDER,
  model: MODEL,
  maxTokens: 1024,
  requestTimeoutMs: 180000,
  // The SDK default is 10s. A cold profile boot on Windows (first materialisation
  // of the profile's node_modules fallback) exceeds that; Studio must raise it or
  // it will report a false failure on first launch.
  initializeTimeoutMs: Number(process.env.PROBE_INIT_TIMEOUT_MS ?? 180000),
})

/** Live view of what a Studio UI would show. */
const timeline = []
let sawRunning = false
let sawIdle = false

try {
  const tStart = Date.now()
  await harness.start()
  summary.startMs = Date.now() - tStart
  ev.append('runtime.started', { startMs: summary.startMs })
  step('runtime handshake complete', `${summary.startMs}ms`)

  summary.childrenWhileRunning = listChildProcesses().map((c) => ({
    pid: c.ProcessId,
    name: c.Name,
    commandline: String(c.CommandLine ?? '').slice(0, 300),
  }))
  ev.append('runtime.children', { children: summary.childrenWhileRunning })
  if (!summary.childrenWhileRunning.some((c) => /dsh/i.test(c.commandline))) {
    throw new Error('expected a live dsh child process after start(); none found')
  }
  step('live dsh child process observed', summary.childrenWhileRunning.map((c) => c.pid).join(','))

  const session = harness.session()
  summary.sessionId = session.id
  ev.append('session.opened', { sessionId: session.id })
  step('session opened', session.id)

  const tRun = Date.now()
  const result = await session.run(PROMPT, {
    onNotification: (notification) => {
      const params = notification.params ?? {}
      timeline.push({ ts: new Date().toISOString(), method: notification.method, params })
      if (notification.method === 'session.status') {
        if (params.status === 'running') sawRunning = true
        if (params.status === 'idle') sawIdle = true
      }
    },
  })
  summary.runMs = Date.now() - tRun

  summary.finalResponse = result.finalResponse
  summary.eventCount = result.events.length
  summary.notificationCount = result.notifications.length
  summary.notificationMethods = [...new Set(result.notifications.map((n) => n.method))]
  summary.sawRunningStatus = sawRunning
  summary.sawIdleStatus = sawIdle
  summary.eventKinds = [
    ...new Set(
      result.events
        .map((e) => e?.type ?? e?.kind ?? (Array.isArray(e) ? e[0] : undefined))
        .filter((v) => typeof v === 'string'),
    ),
  ]
  summary.modelBlocker = detectModelBlocker(result.events)

  ev.append('run.completed', {
    runMs: summary.runMs,
    sessionId: summary.sessionId,
    finalResponse: summary.finalResponse,
    eventCount: summary.eventCount,
    notificationCount: summary.notificationCount,
    notificationMethods: summary.notificationMethods,
    sawRunningStatus: sawRunning,
    sawIdleStatus: sawIdle,
  })
  step('prompt completed', { runMs: summary.runMs, events: summary.eventCount })
  step('final response', JSON.stringify(summary.finalResponse?.slice(0, 200)))

  ev.writeJson('timeline.json', timeline)
  ev.writeJson('events.json', result.events)
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  step('closing runtime')
  const tClose = Date.now()
  try {
    await harness.close()
    summary.closeMs = Date.now() - tClose
    ev.append('runtime.close.requested', { closeMs: summary.closeMs })
  } catch (error) {
    summary.closeError = { name: error?.constructor?.name, message: String(error?.message ?? error) }
    ev.append('runtime.close.error', summary.closeError)
  }

  const reaped = await waitForNoDshChild(15000)
  summary.dshChildGoneAfterClose = reaped.gone
  summary.reapWaitMs = reaped.waitedMs
  summary.childrenAfterClose = listChildProcesses().map((c) => ({ pid: c.ProcessId, name: c.Name }))
  ev.append('runtime.reap', {
    gone: reaped.gone,
    waitedMs: reaped.waitedMs,
    remainingChildren: summary.childrenAfterClose,
  })
  step('post-close child check', { gone: reaped.gone, waitedMs: reaped.waitedMs })

  summary.finishedAt = new Date().toISOString()

  const infraOk =
    !summary.error &&
    !summary.closeError &&
    summary.sawRunningStatus === true &&
    summary.sawIdleStatus === true &&
    summary.eventCount > 0 &&
    summary.dshChildGoneAfterClose === true
  const modelOk = typeof summary.finalResponse === 'string' && summary.finalResponse.length > 0

  summary.verdict = infraOk && modelOk ? 'PASS' : infraOk && summary.modelBlocker?.blocked ? 'BLOCKED' : 'FAIL'
  summary.infrastructureOk = infraOk
  summary.modelResponded = modelOk
  const file = ev.writeJson('summary.json', summary)
  step('summary written', file)
  step(`PROBE_A_RESULT=${summary.verdict}`, {
    infraOk,
    modelResponded: modelOk,
    blocker: summary.modelBlocker?.kind ?? null,
  })
  process.exitCode = EXIT[summary.verdict]
}

// The SDK keeps a child process and subscriptions alive; without an explicit exit a
// hung child would block the whole probe run and look like a silent pass.
process.exit(typeof process.exitCode === "number" ? process.exitCode : 0)
