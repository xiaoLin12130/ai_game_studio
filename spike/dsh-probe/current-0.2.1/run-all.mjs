/**
 * Runs the DSH 0.2.1-rc.3 + commandcode probe suite.
 *
 * These probes exercise the runtime the user actually runs, so this suite — not the
 * 0.1.5 one — is the evidence that matters for production decisions. The 0.1.5
 * suite stays as a frozen legacy baseline.
 *
 * Two gates run before the probes:
 *   1. profile setup — a missing profile, a wrong plugin version or a dependency lock
 *      that does not resolve is a hard failure, never a warning;
 *   2. redaction — every byte forwarded to the console passes through `redact()` line
 *      by line, so a probe that prints a path cannot leak one either.
 *
 * Exit codes: 0 all PASS, 2 any BLOCKED (external dependency), 1 any FAIL.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupProfiles } from './scripts/setup-profiles.mjs'
import { redact } from './src/lib/evidence.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const aggregateDir = path.join(root, 'evidence', '_aggregate')
const probes = [
  ['CC-0-cli', 'src/probe-cli-baseline.mjs'],
  ['CC-1-reply', 'src/probe-commandcode.mjs'],
  ['CC-2-tools', 'src/probe-cc-tools.mjs'],
  ['CC-3-resume', 'src/probe-cc-resume.mjs'],
  ['CC-4-concurrent', 'src/probe-cc-concurrent.mjs'],
  ['CC-5-capability', 'src/probe-capability.mjs'],
]
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 600000)

/**
 * Forward a child stream to the console one line at a time, redacted.
 *
 * Redacting whole chunks is not enough — a path can be split across two chunks and
 * then matches nothing. Line assembly gives each path a chance to be complete.
 */
function lineForwarder(stream) {
  let pending = ''
  return {
    push(chunk) {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) stream.write(`${redact(line)}\n`)
    },
    flush() {
      if (pending) stream.write(redact(pending))
      pending = ''
    },
  }
}

function writeAggregate(summary) {
  fs.mkdirSync(aggregateDir, { recursive: true })
  fs.writeFileSync(path.join(aggregateDir, 'run-all.json'), `${JSON.stringify(redact(summary), null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Gate 1: the environment. A setup failure means the probes would measure something
// other than what the evidence claims, so it stops the run instead of being logged.
// ---------------------------------------------------------------------------
const setupLog = []
let setup
try {
  setup = setupProfiles({
    home: process.env.CC_DSH_HOME ?? path.join(root, 'dsh-home'),
    patchDirectory: path.join(root, 'tmp'),
    log: (event) => setupLog.push(event),
  })
} catch (error) {
  const failure = {
    generatedAt: new Date().toISOString(),
    setup: {
      ok: false,
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 600) },
      detail: error?.detail ?? null,
      steps: setupLog,
    },
    total: 0,
    passed: 0,
    blocked: 0,
    failed: 1,
    note: 'Suite aborted before any probe ran: the profile environment could not be built.',
  }
  writeAggregate(failure)
  process.stderr.write(`\n[setup] FAILED ${failure.setup.error.name}: ${redact(failure.setup.error.message)}\n`)
  if (failure.setup.detail) process.stderr.write(`[setup] detail ${JSON.stringify(redact(failure.setup.detail))}\n`)
  process.stderr.write('[setup] no probe was run; run-all.json records the failure.\n')
  process.exit(1)
}

process.stdout.write(
  `[setup] profiles=${setup.profiles.map((p) => p.name).join(',')}` +
    ` plugin=${setup.plugin.version}` +
    ` credentialPresent=${setup.credential.present}` +
    ` lock=${setup.profiles.map((p) => p.lock.file).join('|')}\n`,
)

// ---------------------------------------------------------------------------
// Gate 2: the probes.
// ---------------------------------------------------------------------------
const results = []

function runProbe(name, script) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(root, script)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const outForward = lineForwarder(process.stdout)
    const errForward = lineForwarder(process.stderr)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      stdout += d
      outForward.push(d)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      errForward.push(d)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      outForward.flush()
      errForward.flush()
      results.push({
        name,
        script,
        exitCode: timedOut ? 1 : (code ?? 1),
        timedOut,
        ms: Date.now() - started,
        stdoutTail: redact(stdout.slice(-1500)),
        stderrTail: redact(stderr.slice(-1500)),
      })
      resolve()
    })
  })
}

for (const [name, script] of probes) {
  process.stdout.write(`\n===== ${name} =====\n`)
  await runProbe(name, script)
}

const classify = (code) => (code === 0 ? 'PASS' : code === 3 ? 'BLOCKED' : 'FAIL')
const buckets = { PASS: [], BLOCKED: [], FAIL: [] }
for (const r of results) {
  r.outcome = classify(r.exitCode)
  buckets[r.outcome].push(r.name)
}

const summary = {
  generatedAt: new Date().toISOString(),
  setup: {
    ok: true,
    home: setup.home,
    profiles: setup.profiles.map((p) => p.name),
    plugin: setup.plugin,
    lock: setup.profiles.map((p) => p.lock),
    provider: setup.provider,
    model: setup.model,
    credentialEnvName: setup.credential.envName,
    credentialPresent: setup.credential.present,
    steps: setupLog,
  },
  runtime: '0.2.1-rc.3',
  provider: 'commandcode',
  model: 'deepseek/deepseek-v4.1-flash',
  node: process.version,
  total: results.length,
  passed: buckets.PASS.length,
  blocked: buckets.BLOCKED.length,
  failed: buckets.FAIL.length,
  buckets,
  results,
}
writeAggregate(summary)

process.stdout.write('\n===== SUMMARY (0.2.1-rc.3 + commandcode) =====\n')
for (const r of results) process.stdout.write(`${r.outcome.padEnd(8)}${r.name}  (exit ${r.exitCode}, ${r.ms}ms)\n`)
process.stdout.write(`\nPASS ${summary.passed}/${summary.total}  BLOCKED ${summary.blocked}  FAIL ${summary.failed}\n`)
process.exitCode = summary.failed > 0 ? 1 : summary.blocked > 0 ? 2 : 0
