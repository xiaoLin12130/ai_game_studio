#!/usr/bin/env node
/**
 * Run the full PHASE 01-A acceptance matrix and write redacted evidence.
 *
 * One entry per command that was actually executed, with its real exit code. Nothing is
 * recorded as PASS unless the process exited 0 in this run. Per-command output is written
 * as .txt (committed) next to the JSON summary; .log is git-ignored, so evidence uses .txt.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const PROBE = path.join(REPO, 'spike', 'dsh-probe', 'current-0.2.1')
const OUT = path.join(REPO, 'evidence', 'phase-01-a')
fs.mkdirSync(OUT, { recursive: true })

const scrub = (text) =>
  String(text)
    .split(REPO).join('<repo>')
    .split(os.homedir()).join('<user-home>')
    .replace(/file:\/\/\/[^"\s]*/g, 'file://<repo>/…')
    .replace(/[A-Za-z]:\\[^"'\r\n]*/g, '<abs-path>')
    .replace(/[A-Za-z]:\/[^"'\r\n]*/g, '<abs-path>')

const baseEnv = { ...process.env }
delete baseEnv.ELECTRON_RUN_AS_NODE

const matrix = []

function run(name, command, argv, cwd, options = {}) {
  const started = Date.now()
  const runResult = spawnSync(process.execPath, argv, {
    cwd,
    encoding: 'utf8',
    env: { ...baseEnv, ...(options.env ?? {}) },
    timeout: 900000,
  })
  const stdout = String(runResult.stdout ?? '')
  const stderr = String(runResult.stderr ?? '')
  const entry = {
    name,
    command,
    cwd: path.relative(REPO, cwd).split(path.sep).join('/') || '.',
    exitCode: runResult.status,
    durationMs: Date.now() - started,
    artifact: options.artifact ?? null,
  }
  const grab = (label) => {
    const match = new RegExp('ℹ ' + label + ' (\\d+)').exec(stdout)
    return match ? Number(match[1]) : null
  }
  if (options.parseTests) {
    entry.counts = { tests: grab('tests'), pass: grab('pass'), fail: grab('fail'), skipped: grab('skipped') }
  }
  if (options.parsePhase00) {
    const match = /(\d+)\/(\d+) tests passed/.exec(stdout)
    entry.counts = match ? { pass: Number(match[1]), total: Number(match[2]) } : null
  }
  if (options.readArtifact) {
    const file = path.resolve(REPO, options.readArtifact)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      entry.artifactStatus = options.artifactStatus(parsed)
    } catch (error) {
      entry.artifactStatus = { error: String(error?.message ?? error) }
    }
  }
  fs.writeFileSync(path.join(OUT, name + '.txt'), scrub(stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')))
  matrix.push(entry)
  console.log(JSON.stringify(entry))
  return entry
}

// 1. TypeScript build.
run(
  'build-typescript',
  'node node_modules/typescript/bin/tsc -p tsconfig.json',
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  ROOT,
)

// 2. Unit + integration + lifecycle + process reclamation tests.
run('unit-and-integration-tests', 'node --test', ['--test'], ROOT, {
  parseTests: true,
  artifact: 'evidence/phase-01-a/app-tests.json',
})

// 3-5. The three desktop scenarios.
for (const scenario of ['ready', 'failure', 'quit-during-probe']) {
  run(
    'desktop-smoke-' + scenario,
    'node scripts/smoke.mjs ' + scenario,
    ['scripts/smoke.mjs', scenario],
    ROOT,
    { artifact: 'evidence/phase-01-a/smoke/' + scenario + '/smoke-run.json' },
  )
}

// 6. PHASE 00 regression suite. Its own evidence round (r154) is not republished.
run(
  'phase00-regression-suite',
  'node tests/run-tests.mjs',
  ['tests/run-tests.mjs'],
  PROBE,
  { parsePhase00: true },
)

// 7. PHASE 00 gates, written into this phase's evidence rather than a PHASE 00 round.
run(
  'phase00-gates',
  'node scripts/run-gates.mjs (CC_GATE_OUT=evidence/phase-01-a/phase00-gates.json)',
  ['scripts/run-gates.mjs'],
  PROBE,
  {
    env: { CC_GATE_OUT: path.join(OUT, 'phase00-gates.json') },
    artifact: 'evidence/phase-01-a/phase00-gates.json',
    readArtifact: 'evidence/phase-01-a/phase00-gates.json',
    artifactStatus: (parsed) => ({ overall: parsed.overall, leaks: parsed.gates?.leak?.leaks?.length ?? null, scanned: parsed.gates?.leak?.scanned ?? null }),
  },
)

const failed = matrix.filter((entry) => entry.exitCode !== 0)
const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  electron: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return null } })(),
  matrix,
  allPassed: failed.length === 0,
  failedEntries: failed.map((entry) => entry.name),
  note: 'PHASE 00 的 r154 证据未被覆盖；第 6/7 项是 PHASE 01-A 侧的一次回归，结果只写在本目录。',
}
fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(summary, null, 2) + '\n')

const tests = matrix.find((entry) => entry.name === 'unit-and-integration-tests')
fs.writeFileSync(path.join(OUT, 'app-tests.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  command: 'node --test',
  exitCode: tests.exitCode,
  durationMs: tests.durationMs,
  counts: tests.counts,
  testFileList: fs.readdirSync(path.join(ROOT, 'test')).filter((name) => name.endsWith('.test.js')).sort(),
}, null, 2) + '\n')

console.log(JSON.stringify({ allPassed: summary.allPassed, failed: summary.failedEntries }, null, 2))
process.exit(summary.allPassed ? 0 : 1)
