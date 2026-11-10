/**
 * Probe C — session persistence across runtime restarts.
 *
 * The wire protocol has no `session/resume` method (probe B proves the -32601), so
 * the architecture question is narrower and answerable: when Studio closes the
 * runtime and later reuses the same session id on a new process, does the runtime
 * append to the existing session log, or start a blank one?
 *
 * That answer decides how Studio must implement crash recovery: rely on session
 * continuity, or replay its own persisted task state and summarise it into a fresh
 * session. The model-recall half of this probe depends on a funded provider and is
 * reported as BLOCKED when the provider refuses.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { waitForNoDshChild, clearStaleProfileLock } from './lib/proc.mjs'
import { EXIT, detectModelBlocker } from './lib/outcome.mjs'

const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'
const CODEWORD = 'ALPHA7'
const SESSION_ID = process.env.PROBE_RESUME_SESSION ?? `probe-resume-${Date.now()}`

const ev = createEvidence('c-resume')
const summary = { probe: 'C-resume', startedAt: new Date().toISOString(), sessionId: SESSION_ID, codeword: CODEWORD }

const dshHome = p('tmp', 'dsh-home')
const workspace = p('tmp', 'workspace')
const sessionsDir = path.join(dshHome, 'sessions')
fs.mkdirSync(dshHome, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

/**
 * Locate this session's durable log.
 * Layout observed on disk: `sessions/<escaped-workspace>/<sessionId>/session.v3.jsonl.zstd`,
 * so the id lives in the directory name, not the file name.
 */
function findSessionLog() {
  if (!fs.existsSync(sessionsDir)) return null
  for (const workspaceDir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!workspaceDir.isDirectory()) continue
    const sessionDir = path.join(sessionsDir, workspaceDir.name, SESSION_ID)
    if (!fs.existsSync(sessionDir)) continue
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('session')) return path.join(sessionDir, entry.name)
    }
  }
  return null
}

/**
 * Inspect the durable session log.
 *
 * Observed schema: a zstd-compressed document (`session.v3.jsonl.zstd`) that
 * decompresses to a very small number of lines, so it is not a plain per-event
 * JSONL stream. This function therefore reports what it can actually prove —
 * decompressibility, size, and the presence of turn/user markers — instead of
 * asserting a turn count the format does not expose.
 */
function readTurnCount(file) {
  if (!file || !fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file)
    const text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
    const lines = text.split('\n').filter(Boolean)
    const count = (needle) => text.split(needle).length - 1
    return {
      compressedBytes: raw.length,
      decompressedBytes: Buffer.byteLength(text, 'utf8'),
      lines: lines.length,
      turnStartMarkers: count('turn/start'),
      userMessageMarkers: count('user/message'),
      schemaSample: text.slice(0, 200),
    }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const launchOptions = {
  profile: 'sdk',
  dshHome,
  cwd: workspace,
  provider: PROVIDER,
  model: MODEL,
  maxTokens: 512,
  requestTimeoutMs: 180000,
  initializeTimeoutMs: Number(process.env.PROBE_INIT_TIMEOUT_MS ?? 180000),
}

try {
  // ---- Turn 1 on a named session, then kill the process entirely.
  const first = new DeepSeekHarness(launchOptions)
  await first.start()
  const run1 = await first.session(SESSION_ID).run(`Remember this codeword: ${CODEWORD}. Reply with just: STORED`)
  summary.turn1 = {
    sessionId: run1.sessionId,
    finalResponse: run1.finalResponse,
    eventCount: run1.events.length,
    modelBlocker: detectModelBlocker(run1.events),
  }
  ev.append('turn1.completed', summary.turn1)
  step('turn1 settled', { events: run1.events.length, blocker: summary.turn1.modelBlocker.kind ?? null })
  await first.close()
  const reaped1 = await waitForNoDshChild(15000)
  summary.turn1ProcessReaped = reaped1.gone

  summary.sessionLogAfterTurn1 = findSessionLog()
  summary.turnCountAfterTurn1 = readTurnCount(summary.sessionLogAfterTurn1)
  ev.append('session.log.afterTurn1', {
    file: summary.sessionLogAfterTurn1,
    counts: summary.turnCountAfterTurn1,
    processReaped: reaped1.gone,
  })
  step('session log after turn1', summary.turnCountAfterTurn1)

  // ---- Turn 2: brand new process, same session id.
  // Expected outcome, given the protocol has no resume method: the runtime refuses
  // to reopen an id it already has on disk. That refusal is the finding, not a bug
  // in this probe, so it is caught and reported rather than thrown.
  const second = new DeepSeekHarness(launchOptions)
  await second.start()
  try {
    const run2 = await second.session(SESSION_ID).run(
      'What was the codeword I asked you to remember? Reply with just the codeword.',
    )
    summary.turn2 = {
      sessionId: run2.sessionId,
      finalResponse: run2.finalResponse,
      eventCount: run2.events.length,
      modelBlocker: detectModelBlocker(run2.events),
    }
    summary.sessionReuseRejected = false
    ev.append('turn2.completed', summary.turn2)
    step('turn2 settled', { events: run2.events.length, blocker: summary.turn2.modelBlocker.kind ?? null })
  } catch (error) {
    summary.turn2 = { error: String(error?.message ?? error) }
    summary.sessionReuseRejected = /already exists/i.test(String(error?.message ?? error))
    ev.append('turn2.rejected', { message: summary.turn2.error, classifiedAsSessionReuse: summary.sessionReuseRejected })
    step('turn2 rejected on session reuse', summary.turn2.error)
  }

  summary.sessionLogAfterTurn2 = findSessionLog()
  summary.turnCountAfterTurn2 = readTurnCount(summary.sessionLogAfterTurn2)
  ev.append('session.log.afterTurn2', {
    file: summary.sessionLogAfterTurn2,
    counts: summary.turnCountAfterTurn2,
  })

  summary.sameLogFile = summary.sessionLogAfterTurn1 === summary.sessionLogAfterTurn2
  summary.logGrew =
    (summary.turnCountAfterTurn2?.decompressedBytes ?? 0) > (summary.turnCountAfterTurn1?.decompressedBytes ?? 0)
  summary.resumeRecalledCodeword = String(summary.turn2?.finalResponse ?? '').includes(CODEWORD)

  await second.close()
  await waitForNoDshChild(15000)
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  // This probe's gate is "the resume question is answered with evidence", not
  // "resume works". A clean refusal is a complete, actionable answer.
  const persistenceVerified = !summary.error && summary.turn1ProcessReaped === true && Boolean(summary.sessionLogAfterTurn1)
  const reuseAnswered = summary.sessionReuseRejected === true || summary.turn2?.eventCount > 0
  const modelVerified = summary.resumeRecalledCodeword === true

  summary.assertions = {
    firstProcessReaped: summary.turn1ProcessReaped === true,
    sessionLogPersisted: Boolean(summary.sessionLogAfterTurn1),
    sessionLogCompressedBytes: summary.turnCountAfterTurn1?.compressedBytes ?? null,
    sessionIdReuseRejected: summary.sessionReuseRejected === true,
    sessionLogStillReadable: typeof summary.turnCountAfterTurn2?.decompressedBytes === 'number',
    modelRecalledCodeword: modelVerified,
  }
  summary.resumeSupported = summary.sessionReuseRejected === false && modelVerified
  summary.conclusion = summary.sessionReuseRejected
    ? 'NO_RESUME_AT_SDK_LEVEL'
    : modelVerified
      ? 'RESUME_BY_SESSION_ID_REUSE'
      : 'ID_REUSE_ACCEPTED_BUT_HISTORY_NOT_RECALLED'
  summary.verdict = persistenceVerified && reuseAnswered ? 'PASS' : 'FAIL'

  summary.finishedAt = new Date().toISOString()
  ev.append('verdict', { verdict: summary.verdict, conclusion: summary.conclusion, assertions: summary.assertions })
  ev.writeJson('summary.json', summary)
  step(`PROBE_C_RESULT=${summary.verdict}`, { conclusion: summary.conclusion, assertions: summary.assertions })
  process.exitCode = EXIT[summary.verdict]
}

// The SDK keeps a child process and subscriptions alive; without an explicit exit a
// hung child would block the whole probe run and look like a silent pass.
process.exit(typeof process.exitCode === "number" ? process.exitCode : 0)
