/**
 * Probe B — protocol-level facts through the low-level official client.
 *
 * Why this probe exists: PHASE 00 must state what the current SDK can and cannot
 * do. Prose in a spec is not evidence, so this probe captures:
 *   - the wire identity the runtime reports (`serverInfo`),
 *   - the exact notification methods the runtime emits,
 *   - whether cancel / resume / session-close methods exist at all.
 *
 * The unsupported-method checks are real JSON-RPC calls: an unknown method must
 * come back as -32601, which is how we justify marking cancel/resume BLOCKED
 * instead of guessing.
 */
import fs from 'node:fs'
import { HarnessClient, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { runtimeVersionFacts } from './lib/proc.mjs'
import { EXIT, detectModelBlocker } from './lib/outcome.mjs'

const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'
const PROMPT = process.env.PROBE_PROMPT ?? 'Reply with exactly one word: PONG'
const IDLE_TIMEOUT_MS = Number(process.env.PROBE_IDLE_TIMEOUT_MS ?? 180000)

const ev = createEvidence('b-protocol-facts')
const summary = { probe: 'B-protocol-facts', startedAt: new Date().toISOString(), runtime: runtimeVersionFacts() }

const dshHome = p('tmp', 'dsh-home')
const workspace = p('tmp', 'workspace')
fs.mkdirSync(dshHome, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })

const client = new HarnessClient({ profile: 'sdk', dshHome, initializeTimeoutMs: Number(process.env.PROBE_INIT_TIMEOUT_MS ?? 180000) })
const notifications = []
const statuses = []

try {
  client.start()
  step('client.start() issued')

  const init = await client.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL, maxTokens: 512 })
  summary.serverInfo = init.serverInfo
  ev.append('initialize.result', { serverInfo: init.serverInfo })
  step('initialize ok', init.serverInfo)

  const subscription = client.subscribe()
  const drain = (async () => {
    try {
      for await (const notification of subscription) {
        notifications.push({ ts: new Date().toISOString(), method: notification.method, params: notification.params })
        if (notification.method === 'session.status') statuses.push(notification.params?.status)
      }
    } catch {
      /* subscription rejects when the runtime closes; expected at teardown */
    }
  })()

  const sessionId = `probe-proto-${Date.now()}`
  summary.sessionId = sessionId
  const messageId = await client.prompt(sessionId, [{ type: 'text', text: PROMPT }])
  summary.promptMessageId = messageId
  ev.append('prompt.queued', { sessionId, messageId })
  step('prompt queued', messageId)

  // Wait for the whole-agent idle transition that ends this activity interval.
  const started = Date.now()
  while (Date.now() - started < IDLE_TIMEOUT_MS) {
    if (statuses.includes('idle') && statuses.includes('running')) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  summary.idleWaitMs = Date.now() - started
  summary.sawRunning = statuses.includes('running')
  summary.sawIdle = statuses.includes('idle')
  summary.statusSequence = statuses
  summary.notificationMethods = [...new Set(notifications.map((n) => n.method))]
  summary.modelBlocker = detectModelBlocker(
    notifications.filter((n) => n.method === 'session.event').map((n) => n.params?.event).filter(Boolean),
  )
  ev.append('run.settled', {
    idleWaitMs: summary.idleWaitMs,
    statusSequence: statuses,
    notificationMethods: summary.notificationMethods,
    notificationCount: notifications.length,
  })
  step('idle observed', { idleWaitMs: summary.idleWaitMs, statuses })

  // Existence checks for methods the spec would like to have.
  summary.unsupportedMethods = {}
  for (const method of ['session/cancel', 'session/resume', 'session/close', 'session/snapshot']) {
    try {
      await client.request(method, { sessionId }, 5000)
      summary.unsupportedMethods[method] = { answered: true }
    } catch (error) {
      summary.unsupportedMethods[method] = {
        errorName: error?.constructor?.name,
        isJsonRpcError: error instanceof JsonRpcResponseError,
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 200),
      }
    }
  }
  ev.append('method.existence', summary.unsupportedMethods)
  step('method existence checked', summary.unsupportedMethods)

  subscription.close()
  await drain
  ev.writeJson('notifications.json', notifications)
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  try {
    await client.close()
    ev.append('client.closed', {})
  } catch (error) {
    summary.closeError = String(error?.message ?? error)
    ev.append('client.close.error', { message: summary.closeError })
  }
  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)

  // The runtime answers unknown methods with -32603 and a descriptive message,
  // not the -32601 its own protocol README documents. Assert on the message so the
  // conclusion survives that discrepancy, and record the code for the report.
  const isUnknownMethod = (method) => {
    const entry = summary.unsupportedMethods?.[method]
    return Boolean(entry?.isJsonRpcError) && /unknown .* method/i.test(entry?.message ?? '')
  }
  const cancelUnsupported = isUnknownMethod('session/cancel')
  const resumeUnsupported = isUnknownMethod('session/resume')
  summary.unknownMethodErrorCode = summary.unsupportedMethods?.['session/cancel']?.code ?? null
  summary.protocolDocClaimsCode = -32601
  // Probe B asserts protocol facts only; it deliberately makes no claim about
  // model output, so a provider quota failure does not invalidate it. The
  // blocker is recorded for transparency.
  const ok =
    !summary.error &&
    summary.serverInfo?.name === 'deepseek-harness-sdk-runtime' &&
    summary.sawRunning === true &&
    summary.sawIdle === true &&
    cancelUnsupported &&
    resumeUnsupported
  summary.verdict = ok ? 'PASS' : 'FAIL'
  ev.writeJson('summary.json', summary)
  step(`PROBE_B_RESULT=${summary.verdict}`, {
    cancelUnsupported,
    resumeUnsupported,
    sawRunning: summary.sawRunning,
    sawIdle: summary.sawIdle,
    modelBlocker: summary.modelBlocker?.kind ?? null,
  })
  process.exitCode = EXIT[summary.verdict]
}

// The SDK keeps a child process and subscriptions alive; without an explicit exit a
// hung child would block the whole probe run and look like a silent pass.
process.exit(typeof process.exitCode === "number" ? process.exitCode : 0)
