/**
 * Probe CC-3 — does `session/resume` actually restore conversation history?
 *
 * PHASE 00 concluded "no resume at SDK level". That was true for 0.1.5, and the
 * review correctly objected to stating it as a permanent DSH limit: 0.2.1-rc.3
 * exposes `session/resume`. This probe measures what it really restores:
 *
 *   turn 1  — teach a random token on session S, then kill the runtime
 *   turn 2  — new process, resumeSession(S), ask for the token back
 *   control — resuming an unknown session id must be rejected, otherwise "resume"
 *             would be an unverifiable no-op
 *
 * Recalling the token is the only thing that proves history came back; the session
 * file existing on disk proves nothing about recoverability.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { EXIT, detectModelBlocker } from './lib/outcome.mjs'

const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const PROFILE = process.env.CC_PROFILE ?? 'cc-sdk'
const TOKEN = `recall-${crypto.randomBytes(3).toString('hex')}`
const IDLE_TIMEOUT_MS = 240000

const ev = createEvidence('cc-3-resume')
const summary = { probe: 'CC-3-resume', startedAt: new Date().toISOString(), provider: PROVIDER, model: MODEL, token: TOKEN }

const dshHome = p('dsh-home')
const workspace = p('workspace')
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

const patchPath = p('tmp', 'cc-provider.cordis.yml')
fs.mkdirSync(path.dirname(patchPath), { recursive: true })
fs.writeFileSync(
  patchPath,
  [
    '# commandcode provider only — enough to prove resume, no tools attached.',
    '- insert:',
    '    - id: llm-commandcode',
    "      name: '@mars-sea/dsh-commandcode-provider'",
    '      config:',
    '        apiKeyEnv: COMMANDCODE_API_KEY',
    '',
  ].join('\n'),
)

/**
 * Run one turn and settle on the whole-agent idle transition.
 * @returns {{text: string, events: Array, statuses: string[]}}
 */
async function runTurn(client, sessionId, text) {
  const statuses = []
  const events = []
  const subscription = client.subscribe()
  const drain = (async () => {
    try {
      for await (const notification of subscription) {
        if (notification.method === 'session.status') statuses.push(notification.params?.status)
        if (notification.method === 'session.event') events.push(notification.params?.event)
      }
    } catch {
      /* expected at teardown */
    }
  })()

  await client.prompt(sessionId, [{ type: 'text', text }])
  const started = Date.now()
  while (Date.now() - started < IDLE_TIMEOUT_MS) {
    if (statuses.includes('idle')) break
    await new Promise((r) => setTimeout(r, 200))
  }
  // Give the log a beat to flush the final assistant message.
  await new Promise((r) => setTimeout(r, 300))

  subscription.close()
  await drain

  const assistantText = events
    .filter((e) => e?.type === 'assistant/message')
    .map((e) => (e.data?.message?.content ?? e.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))
    .join('\n')

  return { text: assistantText, events, statuses }
}

const launch = { profile: PROFILE, dshHome, initializeTimeoutMs: 300000, patches: [patchPath] }
const sessionId = `cc-resume-${Date.now()}`

try {
  // ---- Turn 1: teach the token, then kill the process.
  const first = new HarnessClient(launch)
  first.start()
  summary.serverInfo = (await first.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL, maxTokens: 512 })).serverInfo
  const turn1 = await runTurn(first, sessionId, `记住这个口令：${TOKEN}。只回复一个词：STORED`)
  summary.turn1 = { text: turn1.text, events: turn1.events.length, statuses: turn1.statuses }
  summary.turn1Blocker = detectModelBlocker(turn1.events)
  ev.append('turn1', summary.turn1)
  step('turn1 taught', { textLength: turn1.text.length, blocker: summary.turn1Blocker.kind ?? null })

  await first.close()
  const reaped1 = await waitForRuntimeGone({ dshHome, boundMs: 25000 })
  summary.turn1Reaped = reaped1.status === PROC.ABSENT
  ev.append('turn1.reaped', { status: reaped1.status, waitedMs: reaped1.waitedMs })

  // ---- Control: resuming an id that never existed must fail.
  const probeClient = new HarnessClient(launch)
  probeClient.start()
  await probeClient.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL })
  try {
    await probeClient.resumeSession('definitely-not-a-real-session-id')
    summary.resumeUnknownSessionRejected = false
    summary.resumeUnknownError = null
  } catch (error) {
    summary.resumeUnknownSessionRejected = true
    summary.resumeUnknownError = String(error?.message ?? error).slice(0, 300)
  }
  ev.append('resume.control', {
    rejected: summary.resumeUnknownSessionRejected,
    message: summary.resumeUnknownError,
  })
  await probeClient.close()
  await waitForRuntimeGone({ dshHome, boundMs: 25000 })

  // ---- Turn 2: new process, resume the real session, ask for the token.
  const second = new HarnessClient(launch)
  second.start()
  await second.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL, maxTokens: 512 })
  let resumeError = null
  try {
    await second.resumeSession(sessionId)
  } catch (error) {
    resumeError = String(error?.message ?? error).slice(0, 400)
  }
  summary.resumeError = resumeError
  ev.append('resume.attempt', { sessionId, error: resumeError })

  const turn2 = await runTurn(second, sessionId, '我刚才让你记住的口令是什么？只回答口令本身，不要解释。')
  summary.turn2 = { text: turn2.text, events: turn2.events.length, statuses: turn2.statuses }
  summary.turn2Blocker = detectModelBlocker(turn2.events)
  ev.append('turn2', summary.turn2)
  step('turn2 recall', JSON.stringify(turn2.text.slice(0, 160)))

  await second.close()
  const reaped2 = await waitForRuntimeGone({ dshHome, boundMs: 25000 })
  summary.turn2Reaped = reaped2.status === PROC.ABSENT

  summary.assertions = {
    apiExists: true,
    unknownSessionRejected: summary.resumeUnknownSessionRejected === true,
    resumeCallSucceeded: resumeError === null,
    historyRecalled: String(summary.turn2.text).includes(TOKEN),
    processReapedBothRuns: summary.turn1Reaped && summary.turn2Reaped,
  }
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 1200) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message.slice(0, 300))
} finally {
  const allPass = summary.assertions && Object.values(summary.assertions).every(Boolean)
  const blocked = summary.turn1Blocker?.blocked || summary.turn2Blocker?.blocked
  summary.verdict = allPass ? 'PASS' : summary.error ? 'FAIL' : blocked ? 'BLOCKED' : 'FAIL'

  summary.finishedAt = new Date().toISOString()
  const conclusion = summary.assertions?.historyRecalled
    ? 'RESUME_RESTORES_HISTORY'
    : summary.assertions?.apiExists
      ? 'RESUME_API_EXISTS_HISTORY_UNPROVEN'
      : 'RESUME_UNAVAILABLE'
  summary.conclusion = conclusion
  ev.append('verdict', { verdict: summary.verdict, conclusion, assertions: summary.assertions ?? null })
  ev.writeJson('summary.json', summary)
  step(`CC3_RESULT=${summary.verdict}`, { conclusion, assertions: summary.assertions ?? null })
  process.exitCode = EXIT[summary.verdict]
}

process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
