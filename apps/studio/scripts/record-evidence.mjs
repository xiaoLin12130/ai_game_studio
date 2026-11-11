#!/usr/bin/env node
/**
 * Run the PHASE 01-A verification matrix and write redacted evidence.
 *
 * Every number in the work report comes from here; nothing is transcribed by hand.
 * Each entry records the command, its exit code and the artefact it produced.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-01-a')
fs.mkdirSync(OUT, { recursive: true })

const scrub = (text) =>
  String(text)
    .split(REPO).join('<repo>')
    .split(os.homedir()).join('<user-home>')
    .replace(/file:\/\/\/[^"\s]*/g, 'file://<repo>/…')
    .replace(/[A-Za-z]:\\[^"'\r\n]*/g, '<abs-path>')
    .replace(/[A-Za-z]:\/[^"'\r\n]*/g, '<abs-path>')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const matrix = []
const record = (name, command, argv, cwd, artifact) => {
  const started = Date.now()
  const run = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', env, timeout: 600000 })
  const stdout = String(run.stdout ?? '')
  const stderr = String(run.stderr ?? '')
  const entry = {
    name,
    command,
    exitCode: run.status,
    durationMs: Date.now() - started,
    artifact: artifact ?? null,
  }
  const grab = (label) => {
    const match = new RegExp('ℹ ' + label + ' (\\d+)').exec(stdout)
    return match ? Number(match[1]) : null
  }
  if (name === 'unit-and-integration-tests') {
    entry.counts = { tests: grab('tests'), pass: grab('pass'), fail: grab('fail'), skipped: grab('skipped') }
  }
  if (name.startsWith('desktop-smoke-')) {
    const okLine = /"ok": (true|false)/.exec(stdout)
    entry.ok = okLine ? okLine[1] === 'true' : false
  }
  fs.writeFileSync(path.join(OUT, name + '.log'), scrub(stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')))
  matrix.push(entry)
  console.log(JSON.stringify(entry))
  return entry
}

record('unit-and-integration-tests', 'node --test', ['--test'], ROOT, 'evidence/phase-01-a/app-tests.json')
record('desktop-smoke-ready', 'node scripts/smoke.mjs ready', ['scripts/smoke.mjs', 'ready'], ROOT, 'evidence/phase-01-a/smoke/ready/smoke-run.json')
record('desktop-smoke-failure', 'node scripts/smoke.mjs failure', ['scripts/smoke.mjs', 'failure'], ROOT, 'evidence/phase-01-a/smoke/failure/smoke-run.json')
record(
  'desktop-smoke-quit-during-probe',
  'node scripts/smoke.mjs quit-during-probe',
  ['scripts/smoke.mjs', 'quit-during-probe'],
  ROOT,
  'evidence/phase-01-a/smoke/quit-during-probe/smoke-run.json',
)

const tests = matrix.find((entry) => entry.name === 'unit-and-integration-tests')
const failed = matrix.filter((entry) => entry.exitCode !== 0)
const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  electron: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return null } })(),
  matrix,
  allPassed: failed.length === 0,
  failedEntries: failed.map((entry) => entry.name),
}
fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(summary, null, 2) + '\n')
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
