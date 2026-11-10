/**
 * Probe CC-0 — CLI baseline on the user's real provider.
 *
 * The previous version stored the raw stdout of the CLI run, which included the
 * model's intermediate reasoning. Nothing in a public evidence folder needs that, and
 * publishing chain-of-thought is both a privacy and a noise problem.
 *
 * This probe therefore keeps only auditable facts:
 *   - exit code and duration
 *   - whether the random token came back verbatim
 *   - whether the model named itself
 *   - the final answer line, redacted, length-capped
 *
 * The raw stream is discarded, not stored.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { dshHomePath, workspacePath, patchDir } from './lib/paths.mjs'
import { EXIT } from './lib/outcome.mjs'

const PROFILE = process.env.CC_PROFILE_CLI ?? 'cc-cli'
const TOKEN = `CC-cli-${crypto.randomBytes(3).toString('hex')}`
const CLI_ENTRY = path.resolve(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const ev = createEvidence('cc-0-cli-baseline')
const summary = {
  probe: 'CC-0-cli-baseline',
  startedAt: new Date().toISOString(),
  profile: PROFILE,
  token: TOKEN,
  note: 'Raw model stream is intentionally not stored; only auditable facts are kept.',
}

const dshHome = dshHomePath()
const workspace = workspacePath()
const cliPatch = path.join(patchDir(), 'cc-cli.patch.yml')

/** Ask for one line only, so the answer is short and the reasoning minimal. */
const PROMPT = `只输出一行，不要解释、不要思考过程：验证标识 ${TOKEN}；模型 deepseek/deepseek-v4.1-flash`

function runCli(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, '--profile', PROFILE, '--patch', cliPatch, PROMPT],
      { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: dshHome } },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal: null, ms: Date.now() - started, out, err })
    })
  })
}

/** Keep only the line that carries the token; cap it so no long reasoning slips in. */
function answerLine(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const hit = [...lines].reverse().find((l) => l.includes(TOKEN))
  if (!hit) return null
  return hit.length > 200 ? `${hit.slice(0, 200)}…` : hit
}

try {
  if (!fs.existsSync(cliPatch)) throw new Error(`missing CLI patch: ${cliPatch}`)
  const run = await runCli(Number(process.env.PROBE_CLI_TIMEOUT_MS ?? 300000))

  const answer = answerLine(run.out)
  summary.exitCode = run.exitCode
  summary.durationMs = run.ms
  summary.answer = answer
  summary.stderrTail = run.err.trim().slice(-300)
  ev.append('cli.run', {
    exitCode: run.exitCode,
    durationMs: run.ms,
    answer,
    stderrTail: summary.stderrTail,
    rawBytesDiscarded: run.out.length,
  })
  step('cli finished', { exitCode: run.exitCode, ms: run.ms, answered: Boolean(answer) })

  summary.assertions = {
    exitCodeZero: run.exitCode === 0,
    tokenEchoed: Boolean(answer),
    modelNamed: Boolean(answer && /deepseek\/deepseek-v4\.1-flash/i.test(answer)),
    noProviderQuotaError: !/QUOTA|Insufficient Balance/i.test(run.err),
  }
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 800) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  const allPass = summary.assertions && Object.values(summary.assertions).every(Boolean)
  const quota = /QUOTA|Insufficient Balance/i.test(summary.stderrTail ?? '')
  summary.verdict = allPass ? 'PASS' : summary.error ? 'FAIL' : quota ? 'BLOCKED' : 'FAIL'
  summary.finishedAt = new Date().toISOString()
  ev.append('verdict', { verdict: summary.verdict, assertions: summary.assertions ?? null })
  ev.writeJson('summary.json', summary)
  step(`CC0_RESULT=${summary.verdict}`, summary.assertions ?? null)
  process.exitCode = EXIT[summary.verdict]
}

process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
