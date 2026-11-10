/**
 * Runs the DSH 0.2.1-rc.3 + commandcode probe suite.
 *
 * These probes exercise the runtime the user actually runs, so this suite — not the
 * 0.1.5 one — is the evidence that matters for production decisions. The 0.1.5
 * suite stays as a frozen legacy baseline.
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
const probes = [
  ['CC-1-reply', 'src/probe-commandcode.mjs'],
  ['CC-2-tools', 'src/probe-cc-tools.mjs'],
  ['CC-3-resume', 'src/probe-cc-resume.mjs'],
  ['CC-4-concurrent', 'src/probe-cc-concurrent.mjs'],
  ['CC-5-capability', 'src/probe-capability.mjs'],
]
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 600000)

const results = []

// Build the isolated profiles first: a fresh clone must not depend on state that
// only exists on the author's machine.
const setupLog = []
const setup = setupProfiles({
  home: process.env.CC_DSH_HOME ?? path.join(root, 'dsh-home'),
  patchDirectory: path.join(root, 'tmp'),
  log: (event) => setupLog.push(event),
})
process.stdout.write(
  '[setup] profiles=' +
    setup.profiles.map((p) => p.name).join(',') +
    ' plugin=' +
    setup.plugin.version +
    ' credentialPresent=' +
    setup.credential.present +
    '\n',
)

function runProbe(name, script) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(root, script)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      stdout += d
      process.stdout.write(d)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      process.stderr.write(d)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      results.push({
        name,
        script,
        exitCode: timedOut ? 1 : (code ?? 1),
        timedOut,
        ms: Date.now() - started,
        stdoutTail: stdout.slice(-1500),
        stderrTail: stderr.slice(-1500),
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

const outDir = path.join(root, 'evidence', '_aggregate')
fs.mkdirSync(outDir, { recursive: true })
const summary = {
  generatedAt: new Date().toISOString(),
  setup: { home: setup.home, profiles: setup.profiles.map((p) => p.name), plugin: setup.plugin, provider: setup.provider, model: setup.model, credentialEnvName: setup.credential.envName, credentialPresent: setup.credential.present, steps: setupLog },
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
fs.writeFileSync(path.join(outDir, 'run-all.json'), `${JSON.stringify(redact(summary), null, 2)}\n`)

process.stdout.write('\n===== SUMMARY (0.2.1-rc.3 + commandcode) =====\n')
for (const r of results) process.stdout.write(`${r.outcome.padEnd(8)}${r.name}  (exit ${r.exitCode}, ${r.ms}ms)\n`)
process.stdout.write(`\nPASS ${summary.passed}/${summary.total}  BLOCKED ${summary.blocked}  FAIL ${summary.failed}\n`)
process.exitCode = summary.failed > 0 ? 1 : summary.blocked > 0 ? 2 : 0
