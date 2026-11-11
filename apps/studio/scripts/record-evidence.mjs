#!/usr/bin/env node
/**
 * Run the PHASE 01-A verification matrix and write redacted evidence.
 *
 * Every number in the work report comes from here, and every artefact is produced by a
 * real command — nothing is transcribed by hand.
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

const started = Date.now()
const run = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8', env, timeout: 300000 })
const stdout = String(run.stdout ?? '')
const stderr = String(run.stderr ?? '')

fs.writeFileSync(path.join(OUT, 'app-tests.txt'), scrub(stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')))

const grab = (label) => {
  const match = new RegExp('ℹ ' + label + ' (\\d+)').exec(stdout)
  return match ? Number(match[1]) : null
}
const result = {
  generatedAt: new Date().toISOString(),
  command: 'node --test',
  exitCode: run.status,
  durationMs: Date.now() - started,
  counts: { tests: grab('tests'), pass: grab('pass'), fail: grab('fail'), cancelled: grab('cancelled'), skipped: grab('skipped') },
  testFileList: fs.readdirSync(path.join(ROOT, 'test')).filter((name) => name.endsWith('.test.js')).sort(),
}
fs.writeFileSync(path.join(OUT, 'app-tests.json'), JSON.stringify(result, null, 2) + '\n')

console.log(JSON.stringify(result, null, 2))
process.exit(result.exitCode === 0 && result.counts.fail === 0 ? 0 : 1)
