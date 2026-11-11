/**
 * Overall verdict and exit code for the suite, plus the PHASE 00 state gate.
 *
 * `decideOverall` was extracted from `run-all.mjs` so the claim "a leak fails the
 * run" is provable without running six model probes. `checkProjectState` was added
 * for the same reason, one level up: the project had three different documents each
 * declaring a different object in project_state.json as the authoritative one, and
 * two of those objects still said the two core PHASE 00 gates were BLOCKED. A report
 * that says PASS while the declared source of truth says BLOCKED is not a handoff.
 *
 * The gate only reads files that are already published. It cannot repair anything,
 * and it deliberately refuses an incomplete document set rather than quietly passing.
 */

import fs from 'node:fs'
import path from 'node:path'

export const EXIT = { PASS: 0, BLOCKED: 2, FAIL: 1 }

/**
 * @param {object} input
 * @param {number} [input.failed]      probes that returned FAIL
 * @param {number} [input.blocked]     probes that returned BLOCKED
 * @param {'PASS'|'FAIL'} [input.dependency] dependency gate status
 * @param {'PASS'|'FAIL'} [input.leak]       leak gate status
 * @param {'PASS'|'FAIL'} [input.state]      project-state gate status
 */
export function decideOverall({ failed = 0, blocked = 0, dependency = 'PASS', leak = 'PASS', state = 'PASS' } = {}) {
  const gateFailures = [dependency, leak, state].filter((s) => s === 'FAIL').length
  const overall = failed + gateFailures > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS'
  return { overall, exitCode: EXIT[overall], gateFailures }
}

/** Documents that must point at the single current record. */
export const STATE_DOC_POINTERS = [
  'docs/phase-reports/PHASE_00_REPORT.md',
  'docs/review-handoff/PHASE_00_R1_WORK_REPORT.md',
  'README.md',
  'memory-bank/handoff.md',
]

/** A phrase that declares one of the historical gate sets to be current. */
const STALE_POINTER = /phase_00(?:_r1)?\.gate_results[^\n]{0,60}(?:为准|唯一权威|唯一当前|当前权威)/

/** Historical round records that must survive; deleting them would erase evidence. */
const HISTORICAL_RECORDS = ['r11', 'r12', 'r13', 'r14', 'r141']

/**
 * Read the state file and the pointer documents from a repository root.
 * Separate from the check so tests can inject a mutated state object.
 */
export function loadStateCheck(root, stateFile = null) {
  const file = stateFile ? path.resolve(stateFile) : path.join(root, 'state', 'project_state.json')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const docs = {}
  for (const rel of STATE_DOC_POINTERS) {
    docs[rel] = fs.readFileSync(path.join(root, rel), 'utf8')
  }
  return { state, docs, root }
}

/**
 * Verify that the project has exactly one current state record, that it is complete,
 * that history is preserved, and that no published document points at a stale record.
 *
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, checked: object}}
 */
export function checkProjectState({ state, docs = {}, root = null }) {
  const errors = []
  const fail = (code, message) => errors.push({ code, message })
  const checked = { gates: 0, deferred: 0, unknown: 0, docs: 0 }

  if (!state || typeof state !== 'object') {
    return { ok: false, errors: [{ code: 'state-unreadable', message: 'project_state.json is not an object' }], checked }
  }

  // 1. One declared source of truth, and it is the final record.
  if (state.authoritative_source?.current_record !== 'phase_00_final') {
    fail('authority-missing', 'authoritative_source.current_record must be phase_00_final')
  }

  const final = state.phase_00_final
  if (!final || typeof final !== 'object') {
    return { ok: false, errors: [...errors, { code: 'current-record-missing', message: 'phase_00_final is missing' }], checked }
  }

  // 2. Top-level fields must agree with the current record.
  const allowedVerdicts = ['PASS', 'PARTIALLY_VERIFIED', 'BLOCKED', 'FAIL']
  if (!allowedVerdicts.includes(final.verdict)) fail('verdict-invalid', `unsupported verdict ${final.verdict}`)
  if (state.current_phase !== 'PHASE_00') fail('top-level-phase', 'current_phase must be PHASE_00')
  if (state.product_status !== final.product_status) fail('top-level-status', 'product_status disagrees with phase_00_final.product_status')
  if (state.phase_status?.PHASE_00 !== final.verdict) fail('top-level-verdict', 'phase_status.PHASE_00 disagrees with phase_00_final.verdict')

  // 3. The ten PHASE 00 scope gates: all PASS, each with a real evidence file.
  const gates = final.gates ?? {}
  checked.gates = Object.keys(gates).length
  if (checked.gates !== 10) fail('gate-count', `expected 10 PHASE 00 scope gates, found ${checked.gates}`)
  for (const [id, gate] of Object.entries(gates)) {
    if (gate?.status !== 'PASS') fail('gate-not-pass', `${id} status is ${gate?.status ?? 'missing'}`)
    if (!gate?.evidence) {
      fail('gate-no-evidence', `${id} has no evidence path`)
    } else if (root && !fs.existsSync(path.join(root, gate.evidence))) {
      fail('gate-evidence-missing', `${id} evidence does not exist: ${gate.evidence}`)
    }
  }

  // 4. Every deferred item has a phase, a risk and a verification condition.
  const deferred = final.deferred ?? {}
  checked.deferred = Object.keys(deferred).length
  if (checked.deferred < 8) fail('deferred-count', `expected at least 8 deferred items, found ${checked.deferred}`)
  for (const [id, item] of Object.entries(deferred)) {
    for (const key of ['status', 'phase', 'risk', 'verify_when']) {
      if (!item?.[key]) fail('deferred-incomplete', `${id} is missing ${key}`)
    }
    if (item?.status === 'CONFIRMED' || item?.status === 'PASS') {
      fail('deferred-overclaimed', `${id} is deferred but marked ${item.status}`)
    }
  }

  // 5. UNKNOWN items must say why they are unknown and what would resolve them.
  const unknown = final.unknown ?? {}
  checked.unknown = Object.keys(unknown).length
  if (checked.unknown < 1) fail('unknown-count', 'no UNKNOWN items recorded')
  for (const [id, item] of Object.entries(unknown)) {
    for (const key of ['why_unknown', 'condition_to_verify']) {
      if (!item?.[key]) fail('unknown-incomplete', `${id} is missing ${key}`)
    }
    if (item?.status !== 'UNKNOWN') fail('unknown-status', `${id} status must be UNKNOWN`)
  }

  // 6. HY4 via WorkBuddy is not proof that DSH can call HY4. Never CONFIRMED, never blocking.
  const hy4 = final.independent_verification?.hy4_dsh_direct
  if (!hy4) {
    fail('hy4-missing', 'independent_verification.hy4_dsh_direct is missing')
  } else {
    if (hy4.status !== 'UNKNOWN') fail('hy4-status', `HY4 direct status must be UNKNOWN, got ${hy4.status}`)
    if (hy4.blocking !== false) fail('hy4-blocking', 'HY4 direct must not block PHASE 00')
    if (!/WorkBuddy/.test(String(hy4.note ?? ''))) fail('hy4-note', 'HY4 note must separate WorkBuddy use from DSH direct support')
  }

  // 7. Historical evidence must be preserved, not overwritten by the new record.
  if (!state.phase_00 || !state.phase_00_r1) fail('history-lost', 'phase_00 / phase_00_r1 records are missing')
  for (const key of HISTORICAL_RECORDS) {
    if (!state.phase_00_r1?.[key]) fail('history-lost', `phase_00_r1.${key} is missing`)
  }

  // 8. All pointer documents must name the current record and none may name a stale one.
  const docEntries = Object.entries(docs)
  checked.docs = docEntries.length
  if (docEntries.length < STATE_DOC_POINTERS.length) {
    fail('doc-set-incomplete', `expected ${STATE_DOC_POINTERS.length} pointer documents, got ${docEntries.length}`)
  }
  for (const [rel, text] of docEntries) {
    if (!String(text).includes('phase_00_final')) fail('doc-pointer-missing', `${rel} does not point at phase_00_final`)
    if (STALE_POINTER.test(String(text))) fail('doc-stale-pointer', `${rel} declares a historical gate_results as current`)
  }

  return { ok: errors.length === 0, errors, checked }
}
