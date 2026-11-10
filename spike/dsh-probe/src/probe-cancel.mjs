/**
 * Probe D — "the caller stopped waiting" versus "the runtime stopped working".
 *
 * PHASE 00-R1 review: the first version collapsed several different facts into one
 * verdict, and counted a growing event stream as evidence that the agent was still
 * producing work. Provider error retries also emit events, so that was wrong.
 * This version keeps five assertions separate:
 *
 *   1. runtime alive after the caller abandoned the wait
 *   2. agent still `running` at the moment of abandonment
 *   3. the model produced genuinely new assistant content after abandonment
 *   4. runtime process tree gone after close()
 *   5. no leftover external processes (MCP server / shell) after close()
 */
import fs from 'node:fs'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { findRuntimeProcesses, waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { EXIT, detectModelBlocker } from './lib/outcome.mjs'

const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'
const ABANDON_AFTER_MS = Number(process.env.PROBE_ABANDON_MS ?? 5000)
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
const sessionEvents = []

/** Visible assistant text, used to detect genuinely new output. */
function assistantText(event) {
  if (event?.type !== 'assistant/message') return ''
  const data = event?.data ?? {}
  const blocks = data.message?.content ?? data.content ?? []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

try {
  client.start()
  const init = await client.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL, maxTokens: 6000 })
  summary.serverInfo = init.serverInfo

  const subscription = client.subscribe()
  const drain = (async () => {
    try {
      for await (const notification of subscription) {
        if (notification.method === 'session.status') statuses.push(notification.params?.status)
        if (notification.method === 'session.event') sessionEvents.push(notification.params?.event)
      }
    } catch {
      /* expected on close */
    }
  })()

  const sessionId = `probe-abandon-${Date.now()}`
  summary.sessionId = sessionId
  await client.prompt(sessionId, [{ type: 'text', text: LONG_PROMPT }])
  ev.append('prompt.queued', { sessionId })
  step('long prompt queued')

  const runWaitStart = Date.now()
  while (Date.now() - runWaitStart < 45000 && !statuses.includes('running')) {
    await new Promise((r) => setTimeout(r, 150))
  }
  summary.sawRunning = statuses.includes('running')

  // ---- The caller walks away here: we stop waiting, we do not close.
  const abandonStart = Date.now()
  const textAtAbandon = sessionEvents.map(assistantText).join('').length
  const eventsAtAbandon = sessionEvents.length
  const statusAtAbandon = statuses.at(-1) ?? null
  const procAtAbandon = findRuntimeProcesses({ dshHome })

  await new Promise((r) => setTimeout(r, ABANDON_AFTER_MS))

  const procAfter = findRuntimeProcesses({ dshHome })
  const textAfter = sessionEvents.map(assistantText).join('').length
  const eventsAfter = sessionEvents.length

  summary.abandon = {
    waitedMs: Date.now() - abandonStart,
    statusAtAbandon,
    processStatusAtAbandon: procAtAbandon.status,
    processStatusAfter: procAfter.status,
    processCountAfter: procAfter.matches.length,
    checkError: procAfter.error,
    eventsAtAbandon,
    eventsAfter,
    assistantCharsAtAbandon: textAtAbandon,
    assistantCharsAfter: textAfter,
    newAssistantChars: textAfter - textAtAbandon,
    lastStatus: statuses.at(-1) ?? null,
  }
  ev.append('caller.abandoned', summary.abandon)
  step('caller abandoned the wait', {
    processStatusAfter: procAfter.status,
    statusAtAbandon,
    newAssistantChars: summary.abandon.newAssistantChars,
  })

  summary.cancelAvailable = false
  summary.modelBlocker = detectModelBlocker(sessionEvents)

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

  const reaped = await waitForRuntimeGone({ dshHome, boundMs: 20000 })
  summary.reap = { status: reaped.status, waitedMs: reaped.waitedMs, remaining: reaped.lastMatches, error: reaped.error }
  ev.append('runtime.reap', summary.reap)

  // Independent assertions, each with its own evidence.
  summary.assertions = {
    A_runtimeAliveAfterAbandon: summary.abandon?.processStatusAfter === PROC.PRESENT,
    B_stillRunningAtAbandon: summary.abandon?.statusAtAbandon === 'running',
    C_newAssistantContentAfterAbandon: (summary.abandon?.newAssistantChars ?? 0) > 0,
    D_processTreeGoneAfterClose: reaped.status === PROC.ABSENT,
    E_noLeftoverExternalProcesses: reaped.status === PROC.ABSENT && (reaped.lastMatches?.length ?? 0) === 0,
  }

  const checkFailed = reaped.status === PROC.FAILED || summary.abandon?.processStatusAfter === PROC.FAILED
  const lifecycleOk = summary.assertions.A_runtimeAliveAfterAbandon && summary.assertions.D_processTreeGoneAfterClose
  const workProven = summary.assertions.B_stillRunningAtAbandon && summary.assertions.C_newAssistantContentAfterAbandon

  // FAIL only when our own machinery or the lifecycle claim is wrong. When the
  // provider refuses, the work assertions cannot be exercised → BLOCKED.
  if (checkFailed) summary.verdict = 'FAIL'
  else if (lifecycleOk && workProven) summary.verdict = 'PASS'
  else if (lifecycleOk && summary.modelBlocker?.blocked) summary.verdict = 'BLOCKED'
  else summary.verdict = 'FAIL'

  summary.finishedAt = new Date().toISOString()
  ev.append('verdict', { verdict: summary.verdict, assertions: summary.assertions })
  ev.writeJson('summary.json', summary)
  step(`PROBE_D_RESULT=${summary.verdict}`, summary.assertions)
  process.exitCode = EXIT[summary.verdict]
}

process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
