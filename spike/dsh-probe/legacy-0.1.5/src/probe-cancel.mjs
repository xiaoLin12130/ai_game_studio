/**
 * Probe D — "the caller stopped waiting" is not "the agent stopped working".
 *
 * AGENTS.md 5 and docs/04 both require this distinction to be measured, not
 * asserted. The current protocol has no cancel method, so this probe:
 *   1. starts a long turn,
 *   2. abandons the wait after a short while, exactly as an impatient UI would,
 *   3. checks the OS: is the runtime process still alive and is the agent still
 *      reporting `running`?
 *   4. only then closes, and proves the process exits.
 */
import fs from 'node:fs'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { hasLiveDshChild, listChildProcesses, waitForNoDshChild, clearStaleProfileLock } from './lib/proc.mjs'
import { EXIT } from './lib/outcome.mjs'

const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'
const ABANDON_AFTER_MS = Number(process.env.PROBE_ABANDON_MS ?? 4000)
const LONG_PROMPT =
  'Write a careful 900-word technical explanation of how TCP congestion control works. Do not summarize; produce the full text.'

const ev = createEvidence('d-abandon')
const summary = { probe: 'D-abandon', startedAt: new Date().toISOString(), abandonAfterMs: ABANDON_AFTER_MS }

const dshHome = p('tmp', 'dsh-home')
const workspace = p('tmp', 'workspace')
fs.mkdirSync(dshHome, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

const client = new HarnessClient({
  profile: 'sdk',
  dshHome,
  initializeTimeoutMs: Number(process.env.PROBE_INIT_TIMEOUT_MS ?? 180000),
})
const statuses = []
const events = []

try {
  client.start()
  const init = await client.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL, maxTokens: 4000 })
  summary.serverInfo = init.serverInfo

  const subscription = client.subscribe()
  const drain = (async () => {
    try {
      for await (const notification of subscription) {
        if (notification.method === 'session.status') statuses.push(notification.params?.status)
        if (notification.method === 'session.event') events.push(notification.params)
      }
    } catch {
      /* expected on close */
    }
  })()

  const sessionId = `probe-abandon-${Date.now()}`
  summary.sessionId = sessionId
  await client.prompt(sessionId, [{ type: 'text', text: LONG_PROMPT }])
  ev.append('prompt.queued', { sessionId })
  step('long prompt queued, waiting for running state')

  // Wait until the agent is actually running, bounded.
  const runWaitStart = Date.now()
  while (Date.now() - runWaitStart < 30000 && !statuses.includes('running')) {
    await new Promise((r) => setTimeout(r, 150))
  }
  summary.sawRunning = statuses.includes('running')
  ev.append('agent.running', { sawRunning: summary.sawRunning, waitedMs: Date.now() - runWaitStart })
  step('running observed', { sawRunning: summary.sawRunning })

  // ---- Simulate the caller giving up. We stop waiting; we do NOT close.
  const abandonStart = Date.now()
  const eventsAtAbandon = events.length
  await new Promise((r) => setTimeout(r, ABANDON_AFTER_MS))
  const eventsAfterAbandon = events.length

  summary.abandon = {
    waitedMs: Date.now() - abandonStart,
    childStillAlive: hasLiveDshChild(),
    lastStatus: statuses.at(-1) ?? null,
    eventCountAtAbandon: eventsAtAbandon,
    eventCountAfterAbandon: eventsAfterAbandon,
    eventsKeptArriving: eventsAfterAbandon > eventsAtAbandon,
    childProcesses: listChildProcesses().map((c) => ({ pid: c.ProcessId, name: c.Name })),
  }
  ev.append('caller.abandoned', summary.abandon)
  step('caller abandoned the wait', {
    childStillAlive: summary.abandon.childStillAlive,
    lastStatus: summary.abandon.lastStatus,
    eventsKeptArriving: summary.abandon.eventsKeptArriving,
  })

  summary.cancelAvailable = false
  ev.append('cancel.availability', {
    available: false,
    evidence: 'probe B: session/cancel answered -32601; protocol README states no cancel method',
  })

  subscription.close()
  await drain
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  const tClose = Date.now()
  try {
    await client.close()
    summary.closeMs = Date.now() - tClose
  } catch (error) {
    summary.closeError = String(error?.message ?? error)
  }
  const reaped = await waitForNoDshChild(15000)
  summary.childGoneAfterClose = reaped.gone
  summary.reapWaitMs = reaped.waitedMs
  ev.append('runtime.closed', { closeMs: summary.closeMs ?? null, gone: reaped.gone, waitedMs: reaped.waitedMs })
  step('closed and reaped', { gone: reaped.gone, closeMs: summary.closeMs })

  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)

  const ok = summary.error
    ? false
    : summary.sawRunning === true && summary.abandon?.childStillAlive === true && summary.childGoneAfterClose === true
  // The strong claim — "the agent was still working when the caller walked away" —
  // requires the turn to still be `running` at the moment of abandonment. With a
  // provider refusal the turn may already have ended, so record that distinctly
  // instead of dressing error-retry events up as productive work.
  const stillRunningAtAbandon = summary.abandon?.lastStatus === 'running'
  const longTurnExercised = stillRunningAtAbandon && summary.abandon?.eventsKeptArriving === true
  summary.assertions = {
    agentReachedRunning: summary.sawRunning === true,
    stillRunningAtAbandon,
    processSurvivedAbandonedWait: summary.abandon?.childStillAlive === true,
    processGoneAfterClose: summary.childGoneAfterClose === true,
    noWireCancelMethod: true,
    longTurnKeptProducingWork: longTurnExercised,
  }
  summary.verdict = ok ? (longTurnExercised ? 'PASS' : 'BLOCKED') : 'FAIL'
  ev.append('verdict', { verdict: summary.verdict, assertions: summary.assertions })
  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)
  step(`PROBE_D_RESULT=${summary.verdict}`, summary.assertions)
  process.exitCode = EXIT[summary.verdict]
}

// The SDK keeps a child process and subscriptions alive; without an explicit exit a
// hung child would block the whole probe run and look like a silent pass.
process.exit(typeof process.exitCode === "number" ? process.exitCode : 0)
