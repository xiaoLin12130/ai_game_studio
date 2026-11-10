/**
 * Probe F — concurrency behaviour inside one runtime.
 *
 * Studio will eventually run more than one session (an advisor chat plus a task
 * execution session). This probe checks the cheap, honest question: can one
 * runtime process serve two sessions at once, and do their event streams stay
 * separated? Cross-talk here would corrupt Studio task state later.
 */
import fs from 'node:fs'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { EXIT, detectModelBlocker } from './lib/outcome.mjs'

const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'

const ev = createEvidence('f-concurrent')
const summary = { probe: 'F-concurrent', startedAt: new Date().toISOString() }

const dshHome = p('tmp', 'dsh-home')
const workspace = p('tmp', 'workspace')
fs.mkdirSync(dshHome, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

const harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome,
  cwd: workspace,
  provider: PROVIDER,
  model: MODEL,
  maxTokens: 512,
  requestTimeoutMs: 180000,
  initializeTimeoutMs: Number(process.env.PROBE_INIT_TIMEOUT_MS ?? 180000),
})

try {
  await harness.start()
  step('runtime started')

  const sessionA = harness.session()
  const sessionB = harness.session()
  summary.sessions = [sessionA.id, sessionB.id]

  const t0 = Date.now()
  const [runA, runB] = await Promise.all([
    sessionA.run('Reply with exactly one word: APPLE'),
    sessionB.run('Reply with exactly one word: BANANA'),
  ])
  summary.totalMs = Date.now() - t0

  // RunResult.events are root-session only by contract, so cross-talk is checked on
  // the notification envelope, which carries the sessionId per message.
  const notificationsFor = (run) => run.notifications.map((n) => n?.params?.sessionId).filter(Boolean)
  const sessionsInA = [...new Set(notificationsFor(runA))]
  const sessionsInB = [...new Set(notificationsFor(runB))]

  summary.runA = {
    sessionId: runA.sessionId,
    finalResponse: runA.finalResponse,
    eventCount: runA.events.length,
    eventSessions: sessionsInA,
  }
  summary.runB = {
    sessionId: runB.sessionId,
    finalResponse: runB.finalResponse,
    eventCount: runB.events.length,
    eventSessions: sessionsInB,
  }
  ev.append('runs.completed', { totalMs: summary.totalMs, runA: summary.runA, runB: summary.runB })
  step('both runs settled', { totalMs: summary.totalMs })

  summary.assertions = {
    distinctSessions: sessionA.id !== sessionB.id,
    bothSettled: runA.events.length > 0 && runB.events.length > 0,
    noCrossTalkInA: sessionsInA.length > 0 && sessionsInA.every((id) => id === runA.sessionId),
    noCrossTalkInB: sessionsInB.length > 0 && sessionsInB.every((id) => id === runB.sessionId),
    bothProducedText: runA.finalResponse.length > 0 && runB.finalResponse.length > 0,
    answersNotSwapped: !/BANANA/i.test(runA.finalResponse) && !/APPLE/i.test(runB.finalResponse),
  }
  summary.modelBlocker = detectModelBlocker(runA.events)?.blocked ? detectModelBlocker(runA.events) : detectModelBlocker(runB.events)
  ev.append('assertions', summary.assertions)
  step('assertions', summary.assertions)
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  try {
    await harness.close()
  } catch (error) {
    summary.closeError = String(error?.message ?? error)
  }
  const reaped = await waitForRuntimeGone({ dshHome, boundMs: 20000 })
  summary.childGoneAfterClose = reaped.status === PROC.ABSENT
  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)

  const isolationOk =
    !summary.error &&
    Object.entries(summary.assertions ?? {})
      .filter(([key]) => !['bothProducedText', 'answersNotSwapped'].includes(key))
      .every(([, value]) => value === true) &&
    reaped.status === PROC.ABSENT
  const modelOk = summary.assertions?.bothProducedText === true && summary.assertions?.answersNotSwapped === true
  summary.verdict = isolationOk && modelOk ? 'PASS' : isolationOk && summary.modelBlocker?.blocked ? 'BLOCKED' : 'FAIL'
  ev.append('verdict', { verdict: summary.verdict })
  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)
  step(`PROBE_F_RESULT=${summary.verdict}`, { isolationOk, modelOk })
  process.exitCode = EXIT[summary.verdict]
}

// The SDK keeps a child process and subscriptions alive; without an explicit exit a
// hung child would block the whole probe run and look like a silent pass.
process.exit(typeof process.exitCode === "number" ? process.exitCode : 0)
