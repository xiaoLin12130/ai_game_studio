#!/usr/bin/env node
/**
 * Gate-only regression for R1.4.1.
 *
 * The review explicitly asked not to repeat the six real model probes when the change
 * only touches redaction, scanning and dependency metadata. This script therefore
 * re-runs the two affected gates (dependency consistency and leak scan) with the final
 * code and the final file set, records the result, and exits non-zero on failure.
 *
 * It deliberately does NOT write `evidence/r14/summary.json` or `_aggregate/run-all.json`:
 * those belong to the last full six-probe run and must stay as that run's record.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupProfiles } from './setup-profiles.mjs'
import { REPO_ROOT } from '../src/lib/redact.mjs'
import { scanTree } from '../src/lib/scrub.mjs'
import { loadStateCheck, checkProjectState } from '../src/lib/gates.mjs'
import { writeJsonFile } from '../src/lib/evidence.mjs'
import { out, err } from '../src/lib/safe-output.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const probeRoot = path.resolve(root, '..')
/**
 * PHASE 00 convergence publishes into its own round directory.
 *
 * `evidence/r14/` is the record of the last full six-probe model run plus that round's
 * gate output. Overwriting it with a later gate-only regression would erase which run
 * produced it — the exact failure mode the r14 README exists to prevent. `CC_GATE_ROUND`
 * keeps the old behaviour available for a reproduction that really does want r14.
 */
const round = process.env.CC_GATE_ROUND ?? 'r152'
const output = path.join(probeRoot, 'evidence', round, 'final-gates.json')

const steps = []
let dependency = { status: 'PASS' }
try {
  const setup = setupProfiles({
    home: process.env.CC_DSH_HOME ?? path.join(probeRoot, 'dsh-home'),
    patchDirectory: path.join(probeRoot, 'tmp'),
    log: (event) => steps.push(event),
  })
  dependency = {
    status: 'PASS',
    runtime: setup.runtime,
    profiles: setup.profiles.map((p) => ({ name: p.name, version: p.plugin.version, files: p.plugin.files, lock: p.lock.file })),
    steps,
  }
} catch (error) {
  dependency = {
    status: 'FAIL',
    code: error?.code ?? error?.name ?? 'Error',
    message: String(error?.message ?? error).slice(0, 600),
    steps,
  }
}

const scanned = scanTree({ root: REPO_ROOT, mode: 'git', requireFiles: true })
const leak = {
  status: scanned.ok ? 'PASS' : 'FAIL',
  scanned: scanned.scanned,
  skippedBinary: scanned.skippedBinary,
  filesInPublishSet: scanned.files,
  leaks: scanned.leaks,
  errors: scanned.errors,
}

let state = { status: 'PASS', checked: null, errors: [] }
try {
  const check = checkProjectState(loadStateCheck(REPO_ROOT, process.env.CC_STATE_FILE ?? null))
  state = { status: check.ok ? 'PASS' : 'FAIL', checked: check.checked, errors: check.errors }
} catch (error) {
  state = { status: 'FAIL', checked: null, errors: [{ code: 'state-unreadable', message: String(error?.message ?? error).slice(0, 300) }] }
}

const result = {
  generatedAt: new Date().toISOString(),
  purpose: 'PHASE 00 gate-only regression; the six real model probes were not repeated.',
  modelProbesRun: false,
  lastFullProbeRun: 'spike/dsh-probe/current-0.2.1/evidence/r14/summary.json',
  gates: { dependency, state, leak },
  overall: [dependency.status, state.status, leak.status].every((s) => s === 'PASS') ? 'PASS' : 'FAIL',
}

writeJsonFile(output, result)
out(`[gates] dependency=${dependency.status} state=${state.status} leak=${leak.status} scanned=${scanned.scanned}/${scanned.files} leaks=${scanned.leaks.length}\n`)
if (state.status === 'FAIL') {
  for (const problem of state.errors.slice(0, 12)) out(`[gates] state ${problem.code}: ${problem.message}\n`)
}
if (result.overall !== 'PASS') {
  err(`[gates] FAILED — see ${path.relative(probeRoot, output)}\n`)
  process.exit(1)
}
out(`[gates] ${path.relative(probeRoot, output)}\n`)
