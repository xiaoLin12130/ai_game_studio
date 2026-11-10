/**
 * Probe CC-0 — CLI baseline on the user's real provider.
 *
 * The first version stored the raw stdout of the CLI run, which included the model's
 * intermediate reasoning. The second version still stored a 300-character `stderrTail`,
 * which turned out to carry the same reasoning: the model writes its thinking to the
 * diagnostic stream, not only to stdout.
 *
 * Nothing in a public evidence folder needs any of that, so this probe stores no free
 * text at all beyond the answer line:
 *   - exit code and duration
 *   - the classified failure kind (never the message)
 *   - whether the random token came back verbatim
 *   - whether the model named itself
 *   - the final answer line, redacted, length-capped
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { dshHomePath, workspacePath, patchDir } from './lib/paths.mjs'
import { EXIT } from './lib/outcome.mjs'
import { classifyRun, BLOCKING_KINDS } from './lib/diagnostics.mjs'

const PROFILE = process.env.CC_PROFILE_CLI ?? 'cc-cli'
const TOKEN = `CC-cli-${crypto.randomBytes(3).toString('hex')}`
const CLI_ENTRY = path.resolve(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const ev = createEvidence('cc-0-cli-baseline')
const summary = {
  probe: 'CC-0-cli-baseline',
  startedAt: new Date().toISOString(),
  profile: PROFILE,
  token: TOKEN,
  note: 'No model text is stored: only the answer line, the exit code and a failure class.',
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

/** Classify a run from both streams without copying either of them. */

try {
  if (!fs.existsSync(cliPatch)) throw new Error(`missing CLI patch: ${path.basename(cliPatch)}`)
  const run = await runCli(Number(process.env.PROBE_CLI_TIMEOUT_MS ?? 300000))

  const answer = answerLine(run.out)
  summary.exitCode = run.exitCode
  summary.durationMs = run.ms
  summary.answer = answer
  summary.diagnostics = classifyRun({ stdout: run.out, stderr: run.err })
  ev.append('cli.run', {
    exitCode: run.exitCode,
    durationMs: run.ms,
    answer,
    diagnostics: summary.diagnostics,
  })
  step('cli finished', { exitCode: run.exitCode, ms: run.ms, answered: Boolean(answer), errorKind: summary.diagnostics.kind })

  summary.assertions = {
    exitCodeZero: run.exitCode === 0,
    tokenEchoed: Boolean(answer),
    modelNamed: Boolean(answer && /deepseek\/deepseek-v4\.1-flash/i.test(answer)),
    noProviderQuotaError: summary.diagnostics.kind !== 'QUOTA',
    noPluginIncompatibility: summary.diagnostics.kind !== 'PLUGIN_INCOMPATIBLE',
  }
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 800) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
} finally {
  const allPass = summary.assertions && Object.values(summary.assertions).every(Boolean)
  const blocked = BLOCKING_KINDS.includes(summary.diagnostics?.kind)
  summary.verdict = allPass ? 'PASS' : summary.error ? 'FAIL' : blocked ? 'BLOCKED' : 'FAIL'
  summary.finishedAt = new Date().toISOString()
  ev.append('verdict', { verdict: summary.verdict, assertions: summary.assertions ?? null })
  ev.writeJson('summary.json', summary)
  step(`CC0_RESULT=${summary.verdict}`, summary.assertions ?? null)
  process.exitCode = EXIT[summary.verdict]
}

process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
