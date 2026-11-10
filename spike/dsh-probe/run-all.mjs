/**
 * Runs every PHASE 00 probe in order and aggregates the result.
 *
 * A probe that throws, times out, or fails its assertions must make this script
 * exit non-zero. Per AGENTS.md 7, a green summary is worthless if the individual
 * checks can silently swallow failures, so each child's exit code is enforced.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const probes = [
  ['A-basic-run', 'src/probe-basic.mjs'],
  ['B-protocol-facts', 'src/probe-protocol.mjs'],
  ['C-resume', 'src/probe-resume.mjs'],
  ['D-abandon', 'src/probe-cancel.mjs'],
  ['E-tools', 'src/probe-tools.mjs'],
  ['F-concurrent', 'src/probe-concurrent.mjs'],
  ['G-exit-code', 'src/probe-exitcode.mjs'],
]

const results = []

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 300000)

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

    // A probe that never settles must fail loudly instead of blocking the gate.
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
      if (timedOut) stdout += `\n[run-all] probe exceeded ${PROBE_TIMEOUT_MS}ms and was killed\n`
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

const outDir = path.join(root, 'evidence', '_aggregate')
fs.mkdirSync(outDir, { recursive: true })

/** 0 = PASS, 3 = BLOCKED (external dependency), anything else = FAIL. */
const classify = (code) => (code === 0 ? 'PASS' : code === 3 ? 'BLOCKED' : 'FAIL')
const buckets = { PASS: [], BLOCKED: [], FAIL: [] }
for (const r of results) {
  r.outcome = classify(r.exitCode)
  buckets[r.outcome].push(r.name)
}

const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  total: results.length,
  passed: buckets.PASS.length,
  blocked: buckets.BLOCKED.length,
  failed: buckets.FAIL.length,
  buckets,
  results,
}
fs.writeFileSync(path.join(outDir, 'run-all.json'), `${JSON.stringify(summary, null, 2)}\n`)

process.stdout.write(`\n===== SUMMARY =====\n`)
for (const r of results) {
  process.stdout.write(`${r.outcome.padEnd(8)}${r.name}  (exit ${r.exitCode}, ${r.ms}ms)\n`)
}
process.stdout.write(`\nPASS ${summary.passed}/${summary.total}  BLOCKED ${summary.blocked}  FAIL ${summary.failed}\n`)

// A blocked probe is not a pass. Exit 2 keeps the distinction machine-readable so
// CI and the review gate cannot mistake "could not test" for "tested and fine".
process.exitCode = summary.failed > 0 ? 1 : summary.blocked > 0 ? 2 : 0
