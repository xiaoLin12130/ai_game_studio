#!/usr/bin/env node
/**
 * Publishes the regression-test result, but only for a passing run.
 *
 * `run-tests.mjs` never writes into the repository on its own — it writes wherever
 * `CC_TEST_EVIDENCE_OUT` says (a temp directory by default). This wrapper runs it,
 * inspects the real exit code, and copies the result into `evidence/r14/tests.json`
 * only when the exit code is 0. A broken or failing run therefore cannot replace the
 * published evidence with a FAIL record or with partial results.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { out, err } from '../src/lib/safe-output.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_ROOT = path.resolve(HERE, '..')
const resultFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tests-')), 'tests.json')
// Same rule as `scripts/run-gates.mjs`: a convergence round publishes its own result
// instead of overwriting the record of the previous round.
const round = process.env.CC_GATE_ROUND ?? 'r15'
const published = path.join(PROBE_ROOT, 'evidence', round, 'tests.json')

const run = spawnSync(process.execPath, [path.join(HERE, 'run-tests.mjs')], {
  cwd: PROBE_ROOT,
  encoding: 'utf8',
  env: { ...process.env, CC_TEST_EVIDENCE_OUT: resultFile },
})

// Forward through the single redacted output layer too. An uncaught exception in the
// child never reaches `err()` and its stack trace contains absolute paths, so a raw
// stream write here would undo the whole output-safety chain.
if (run.stdout) out(run.stdout)
if (run.stderr) err(run.stderr)

if (run.status !== 0) {
  err(`[tests] FAILED (exit ${run.status}); published evidence was left untouched.\n`)
  process.exit(run.status ?? 1)
}

if (!fs.existsSync(resultFile)) {
  err('[tests] the runner exited 0 but produced no result file; not publishing.\n')
  process.exit(1)
}

fs.mkdirSync(path.dirname(published), { recursive: true })
fs.copyFileSync(resultFile, published)
out(`[tests] published ${path.relative(PROBE_ROOT, published)} (exit 0)\n`)
