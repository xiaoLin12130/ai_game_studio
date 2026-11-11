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
import { writeJsonFile } from '../src/lib/evidence.mjs'
import { out, err } from '../src/lib/safe-output.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const probeRoot = path.resolve(root, '..')
const output = path.join(probeRoot, 'evidence', 'r14', 'final-gates.json')

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

const result = {
  generatedAt: new Date().toISOString(),
  purpose: 'R1.4.1 gate-only regression; the six real model probes were not repeated.',
  modelProbesRun: false,
  lastFullProbeRun: 'spike/dsh-probe/current-0.2.1/evidence/r14/summary.json',
  gates: { dependency, leak },
  overall: dependency.status === 'PASS' && leak.status === 'PASS' ? 'PASS' : 'FAIL',
}

writeJsonFile(output, result)
out(`[gates] dependency=${dependency.status} leak=${leak.status} scanned=${scanned.scanned}/${scanned.files} leaks=${scanned.leaks.length}\n`)
if (result.overall !== 'PASS') {
  err(`[gates] FAILED — see ${path.relative(probeRoot, output)}\n`)
  process.exit(1)
}
out(`[gates] ${path.relative(probeRoot, output)}\n`)
