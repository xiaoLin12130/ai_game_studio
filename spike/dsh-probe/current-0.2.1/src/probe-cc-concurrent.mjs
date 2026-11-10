/**
 * Probe CC-4 — two sessions on one runtime with the real provider.
 *
 * The review asked not to let a provider failure mask infrastructure evidence, and
 * not to let infrastructure evidence pass as model evidence. With commandcode both
 * halves can finally be asserted together: distinct sessions, no notification
 * cross-talk, and two genuinely different model answers that are not swapped.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { dshHomePath, workspacePath } from './lib/paths.mjs'
import { waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { EXIT, detectModelBlocker, requestRoute, routeMatches, requestRoutes, allRoutesMatch } from './lib/outcome.mjs'

const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const PROFILE = process.env.CC_PROFILE ?? 'cc-sdk'

const ev = createEvidence('cc-4-concurrent')
const summary = { probe: 'CC-4-concurrent', startedAt: new Date().toISOString(), provider: PROVIDER, model: MODEL }

const dshHome = dshHomePath()
const workspace = workspacePath()
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

const patchPath = p('tmp', 'cc-provider.cordis.yml')
fs.mkdirSync(path.dirname(patchPath), { recursive: true })
fs.writeFileSync(
  patchPath,
  ['- insert:', '    - id: llm-commandcode', "      name: '@mars-sea/dsh-commandcode-provider'", '      config:', '        apiKeyEnv: COMMANDCODE_API_KEY', ''].join('\n'),
)

const harness = new DeepSeekHarness({
  profile: PROFILE,
  dshHome,
  cwd: workspace,
  provider: PROVIDER,
  model: MODEL,
  maxTokens: 256,
  requestTimeoutMs: 300000,
  initializeTimeoutMs: 300000,
  patches: [patchPath],
})

try {
  await harness.start()
  const a = harness.session()
  const b = harness.session()
  summary.sessions = [a.id, b.id]

  const t0 = Date.now()
  const [runA, runB] = await Promise.all([
    a.run('只回复一个词：APPLE'),
    b.run('只回复一个词：BANANA'),
  ])
  summary.totalMs = Date.now() - t0

  const idsFor = (run) => [...new Set(run.notifications.map((n) => n?.params?.sessionId).filter(Boolean))]
  summary.runA = { sessionId: runA.sessionId, text: runA.finalResponse, eventSessions: idsFor(runA), route: requestRoute(runA.events), routes: requestRoutes(runA.events) }
  summary.runB = { sessionId: runB.sessionId, text: runB.finalResponse, eventSessions: idsFor(runB), route: requestRoute(runB.events), routes: requestRoutes(runB.events) }
  ev.append('runs', { totalMs: summary.totalMs, runA: summary.runA, runB: summary.runB })
  step('both settled', { totalMs: summary.totalMs, a: runA.finalResponse.slice(0, 40), b: runB.finalResponse.slice(0, 40) })

  summary.modelBlocker = detectModelBlocker(runA.events)?.blocked ? detectModelBlocker(runA.events) : detectModelBlocker(runB.events)
  summary.assertions = {
    distinctSessionIds: a.id !== b.id,
    eventsOnlyForOwnSessionA: summary.runA.eventSessions.every((id) => id === runA.sessionId),
    eventsOnlyForOwnSessionB: summary.runB.eventSessions.every((id) => id === runB.sessionId),
    bothProducedText: runA.finalResponse.trim().length > 0 && runB.finalResponse.trim().length > 0,
    answersNotSwapped: /APPLE/i.test(runA.finalResponse) && /BANANA/i.test(runB.finalResponse),
    routeBothRunsCommandcode://n      routeMatches(summary.runA.route, { provider: PROVIDER, model: MODEL }) &&
      routeMatches(summary.runB.route, { provider: PROVIDER, model: MODEL }),
    allRequestsOnExpectedRoute://n      allRoutesMatch(runA.events, { provider: PROVIDER, model: MODEL }) &&
      allRoutesMatch(runB.events, { provider: PROVIDER, model: MODEL }),
    noLeftoversAfterClose: false,
  }
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 1200) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message.slice(0, 300))
} finally {
  try {
    await harness.close()
  } catch (error) {
    summary.closeError = String(error?.message ?? error)
  }
  const reaped = await waitForRuntimeGone({ dshHome, boundMs: 25000 })
  summary.reap = { status: reaped.status, waitedMs: reaped.waitedMs, remaining: reaped.lastMatches, error: reaped.error }
  if (summary.assertions) summary.assertions.noLeftoversAfterClose = reaped.status === PROC.ABSENT

  const allPass = summary.assertions && Object.values(summary.assertions).every(Boolean)
  summary.verdict = allPass ? 'PASS' : summary.modelBlocker?.blocked ? 'BLOCKED' : 'FAIL'

  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)
  step(`CC4_RESULT=${summary.verdict}`, summary.assertions ?? null)
  process.exitCode = EXIT[summary.verdict]
}

process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
