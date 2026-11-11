/**
 * Runs the DSH 0.2.1-rc.3 + commandcode probe suite and its gates.
 *
 * Order is deliberate:
 *   1. dependency gate   — profiles must match the lockfile before anything runs;
 *   1b. state gate       — the published project state must have one current record;
 *   2. probes            — six probes, each with its own verdict;
 *   3. leak gate         — the published tree is scanned after the run, because the run
 *                          itself writes evidence and that evidence is what leaks;
 *   4. aggregate         — written only after the gates, so it cannot claim a result the
 *                          gates did not produce.
 *
 * A gate failure is a suite failure. Six PASS probes do not outvote a leak or a drifted
 * dependency; the exit code is non-zero either way.
 *
 * Exit codes: 0 all PASS, 2 any BLOCKED, 1 any FAIL or gate failure.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupProfiles } from './scripts/setup-profiles.mjs'
import { redact, REPO_ROOT } from './src/lib/redact.mjs'
import { scanTree } from './src/lib/scrub.mjs'
import { out, err, createForwarder } from './src/lib/safe-output.mjs'
import { writeJsonFile } from './src/lib/evidence.mjs'
import { decideOverall, loadStateCheck, checkProjectState, officialStateFile } from './src/lib/gates.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
/**
 * `CC_EVIDENCE_OUT` lets the regression tests run the whole suite against a throwaway
 * evidence directory, so a deliberately failing run cannot overwrite the real results.
 */
const evidenceRoot = process.env.CC_EVIDENCE_OUT ? path.resolve(process.env.CC_EVIDENCE_OUT) : path.join(root, 'evidence')
/**
 * A full run publishes into its own round directory.
 *
 * It used to write straight into `evidence/r14/`, which is the frozen record of the
 * 2026-11-10 six-probe run — the only real model evidence in the repository. Running
 * `npm test` again would have overwritten that file while `state/project_state.json`
 * still cited its timestamp, leaving the repository holding evidence that contradicts
 * its own state. A new run gets a new round; `CC_FULL_ROUND` names it.
 */
const fullRound = process.env.CC_FULL_ROUND ?? 'r154'
const aggregateDir = path.join(evidenceRoot, fullRound, '_aggregate')
const bundleDir = path.join(evidenceRoot, fullRound)

const probes = [
  ['CC-0-cli', 'src/probe-cli-baseline.mjs'],
  ['CC-1-reply', 'src/probe-commandcode.mjs'],
  ['CC-2-tools', 'src/probe-cc-tools.mjs'],
  ['CC-3-resume', 'src/probe-cc-resume.mjs'],
  ['CC-4-concurrent', 'src/probe-cc-concurrent.mjs'],
  ['CC-5-capability', 'src/probe-capability.mjs'],
]
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 600000)

const results = []
const startedAt = new Date().toISOString()

// ---------------------------------------------------------------------------
// Gate 1: dependencies
// ---------------------------------------------------------------------------
const setupLog = []
let setup = null
let setupFailure = null
try {
  setup = setupProfiles({
    home: process.env.CC_DSH_HOME ?? path.join(root, 'dsh-home'),
    patchDirectory: path.join(root, 'tmp'),
    log: (event) => setupLog.push(event),
  })
} catch (error) {
  setupFailure = {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 600),
    detail: error?.detail ?? null,
  }
}

const dependencyGate = setupFailure
  ? { status: 'FAIL', ...setupFailure, steps: setupLog }
  : {
      status: 'PASS',
      profiles: setup.profiles.map((p) => ({
        name: p.name,
        version: p.plugin.version,
        files: p.plugin.files,
        lock: p.lock.file,
        repaired: p.profileRepaired,
      })),
      runtime: setup.runtime,
      steps: setupLog,
    }

if (setupFailure) {
  err(`\n[gate:deps] FAILED ${setupFailure.name}${setupFailure.code ? ` (${setupFailure.code})` : ''}: ${setupFailure.message}\n`)
  if (setupFailure.detail) err(`[gate:deps] detail ${JSON.stringify(setupFailure.detail)}\n`)
  err('[gate:deps] no probe was run.\n')
} else {
  out(
    `[setup] profiles=${setup.profiles.map((p) => p.name).join(',')}` +
      ` plugin=${setup.plugin.version}` +
      ` runtime=${setup.runtime.status}` +
      ` credentialPresent=${setup.credential.present}` +
      ` lock=${setup.profiles.map((p) => p.lock.file).join('|')}\n`,
  )
}

// ---------------------------------------------------------------------------
// Gate 1b: the published project state must have exactly one current record
// ---------------------------------------------------------------------------
// `CC_STATE_FILE` is a test seam: the negative test points it at a mutated copy so a
// broken state can be proven to abort the suite without touching the real state file
// or spending a single model call. It is honoured only in an explicit test run
// (`CC_TEST_MODE=1`); an official `npm test` refuses it instead of grading something
// other than the repository's own state.
let stateGate = { status: 'PASS', checked: null, errors: [] }
const stateOverride = officialStateFile(process.env)
// PHASE 01 engineering item 8.2: the summary has to say which state it graded, otherwise
// a test-injected full run produces an aggregate indistinguishable from an official one.
// `scripts/run-gates.mjs` already records this; the full-run summary did not.
const stateSource = {
  kind: stateOverride.testOverride ? 'test-injected' : 'repository',
  file: stateOverride.testOverride ? String(stateOverride.file) : 'state/project_state.json',
}
if (!stateOverride.ok) {
  stateGate = { status: 'FAIL', checked: null, errors: [stateOverride.error], stateSource }
} else {
  try {
    const loaded = loadStateCheck(REPO_ROOT, stateOverride.file)
    const check = checkProjectState(loaded)
    stateGate = {
      status: check.ok ? 'PASS' : 'FAIL',
      checked: check.checked,
      errors: check.errors,
      stateSource,
    }
  } catch (error) {
    stateGate = { status: 'FAIL', checked: null, errors: [{ code: 'state-unreadable', message: String(error?.message ?? error).slice(0, 300) }] }
  }
}

if (stateGate.status === 'FAIL') {
  err(`\n[gate:state] FAILED — ${stateGate.errors.length} problem(s)\n`)
  for (const problem of stateGate.errors.slice(0, 12)) err(`[gate:state] ${problem.code}: ${problem.message}\n`)
  err('[gate:state] no probe was run.\n')
} else {
  out(`[gate:state] PASS (gates=${stateGate.checked?.gates} deferred=${stateGate.checked?.deferred} unknown=${stateGate.checked?.unknown} docs=${stateGate.checked?.docs})\n`)
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------
function runProbe(name, script) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(root, script)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const stdoutForward = createForwarder(process.stdout)
    const stderrForward = createForwarder(process.stderr)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PROBE_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      stdoutForward.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      stderrForward.push(chunk)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stdoutForward.flush()
      stderrForward.flush()
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

if (!setupFailure && stateGate.status !== 'FAIL') {
  for (const [name, script] of probes) {
    out(`\n===== ${name} =====\n`)
    await runProbe(name, script)
  }
}

const classify = (code) => (code === 0 ? 'PASS' : code === 3 ? 'BLOCKED' : 'FAIL')
const buckets = { PASS: [], BLOCKED: [], FAIL: [] }
for (const item of results) {
  item.outcome = classify(item.exitCode)
  buckets[item.outcome].push(item.name)
}

// ---------------------------------------------------------------------------
// Gate 2: the published tree must not carry machine paths
// ---------------------------------------------------------------------------
const scrub = scanTree({ root: REPO_ROOT, mode: 'git', requireFiles: true })
const leakGate = {
  status: scrub.ok ? 'PASS' : 'FAIL',
  scanned: scrub.scanned,
  files: scrub.files,
  leaks: scrub.leaks.slice(0, 50),
  errors: scrub.errors,
}

out(`\n[gate:leak] mode=${scrub.mode} files=${scrub.files} scanned=${scrub.scanned} leaks=${scrub.leaks.length}\n`)
if (!scrub.ok) {
  for (const leak of scrub.leaks.slice(0, 20)) {
    out(`[gate:leak] ${leak.file}${leak.line ? `:${leak.line}` : ''} [${leak.rule}]\n`)
  }
  for (const error of scrub.errors) out(`[gate:leak] error ${error.stage}: ${error.message}\n`)
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------
const verdict = decideOverall({
  failed: buckets.FAIL.length,
  blocked: buckets.BLOCKED.length,
  dependency: dependencyGate.status,
  leak: leakGate.status,
  state: stateGate.status,
})

const summary = {
  generatedAt: new Date().toISOString(),
  startedAt,
  runtime: '0.2.1-rc.3',
  provider: 'commandcode',
  model: 'deepseek/deepseek-v4.1-flash',
  node: process.version,
  gates: {
    dependency: dependencyGate,
    state: stateGate,
    leak: leakGate,
  },
  setup: setup
    ? {
        home: setup.home,
        profiles: setup.profiles.map((p) => p.name),
        plugin: setup.plugin,
        lock: setup.profiles.map((p) => p.lock),
        provider: setup.provider,
        model: setup.model,
        runtime: setup.runtime,
        credentialEnvName: setup.credential.envName,
        credentialPresent: setup.credential.present,
      }
    : null,
  total: results.length,
  passed: buckets.PASS.length,
  blocked: buckets.BLOCKED.length,
  failed: buckets.FAIL.length,
  buckets,
  results,
  overall: verdict.overall,
  exitCode: verdict.exitCode,
}

writeJsonFile(path.join(aggregateDir, 'run-all.json'), summary)
writeJsonFile(path.join(bundleDir, 'summary.json'), summary)

/* The bundle splits the gates out so a reviewer can read one file each. */
writeJsonFile(path.join(bundleDir, 'scrub.json'), { generatedAt: summary.generatedAt, ...leakGate })
writeJsonFile(path.join(bundleDir, 'dependencies.json'), { generatedAt: summary.generatedAt, gate: dependencyGate })

out('\n===== SUMMARY (0.2.1-rc.3 + commandcode) =====\n')
out(`${dependencyGate.status.padEnd(8)}gate:dependency\n`)
out(`${stateGate.status.padEnd(8)}gate:state\n`)
for (const item of results) out(`${item.outcome.padEnd(8)}${item.name}  (exit ${item.exitCode}, ${item.ms}ms)\n`)
out(`${leakGate.status.padEnd(8)}gate:leak  (scanned ${scrub.scanned}, leaks ${scrub.leaks.length})\n`)
out(
  `\nPASS ${summary.passed}/${summary.total}  BLOCKED ${summary.blocked}  FAIL ${summary.failed}  GATES ${dependencyGate.status}/${stateGate.status}/${leakGate.status}\n`,
)
out(`OVERALL ${summary.overall}\n`)

process.exitCode = verdict.exitCode
