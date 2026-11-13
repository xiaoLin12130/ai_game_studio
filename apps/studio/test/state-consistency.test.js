/**
 * The repository's own record has to agree with itself.
 *
 * A state file that says PHASE_00 while the branch is PHASE 02 is not a cosmetic problem:
 * it is the file a reviewer reads to decide whether the project is where it claims to be.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..', '..')
const read = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'))

test('every state file parses', () => {
  const dir = path.join(REPO, 'state')
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    assert.doesNotThrow(() => read(path.join('state', name)), name + ' must be valid JSON')
  }
})

test('current_phase matches the work actually on the branch', () => {
  const state = read('state/project_state.json')
  assert.equal(state.current_phase, 'PHASE_02')
  assert.match(state.github.current_branch, /^phase\/02-/)
  assert.equal(state.phase_status.PHASE_02, 'READY_FOR_EXTERNAL_REVIEW')
})

test('phase_status is copied from the per-phase files, not invented', () => {
  const state = read('state/project_state.json')
  const pairs = [
    ['PHASE_01-A', 'state/phase_01_a.json'],
    ['PHASE_01-B', 'state/phase_01_b.json'],
    ['PHASE_01-C', 'state/phase_01_c.json'],
    ['PHASE_01-D', 'state/phase_01_d.json'],
    ['PHASE_02', 'state/phase_02.json'],
  ]
  for (const [phase, file] of pairs) {
    const recorded = read(file).status
    assert.equal(state.phase_status[phase], recorded, phase + ' must equal ' + file + ' (%s vs %s)', state.phase_status[phase], recorded)
  }
})

test('PHASE 01-D is recorded as closed, with its attestation named', () => {
  const state = read('state/phase_01_d.json')
  assert.equal(state.status, 'CLOSED_PASS')
  assert.equal(state.verdict, 'APPROVED_BY_EXTERNAL_REVIEW')
  assert.ok(state.closure, 'a closure record must exist')
  assert.equal(state.closure.final_code_commit, 'ea6c593301595e6909ff0b0a65de859eba41ca05')
  assert.match(state.closure.attestation, /外部评审/)
  // The remediation history is not rewritten by the closure.
  assert.ok(state.remediation && state.remediation_2 && state.remediation_3, 'all three remediation rounds must still be present')
})

test('PHASE 02 is not marked approved', () => {
  const state = read('state/phase_02.json')
  assert.equal(state.status, 'READY_FOR_EXTERNAL_REVIEW')
  assert.notEqual(state.status, 'APPROVED')
  const global = read('state/project_state.json')
  assert.notEqual(global.phase_status.PHASE_02, 'APPROVED')
})

test('no phase is claimed closed on a branch that never delivered it', () => {
  const state = read('state/project_state.json')
  for (const [phase, status] of Object.entries(state.phase_status)) {
    if (status === 'CLOSED_PASS' || status === 'APPROVED') {
      // A closed phase must point at something: either its own state file or its evidence.
      const closure = state.stage_closures?.[phase]
      assert.ok(closure, phase + ' is marked ' + status + ' but has no closure record')
    }
  }
})

test('the branch history ends at the current branch', () => {
  const state = read('state/project_state.json')
  assert.equal(state.github.branch_history[state.github.branch_history.length - 1], state.github.current_branch)
})

test('the active task points at the current phase', () => {
  const task = read('state/active_task.json')
  const state = read('state/project_state.json')
  assert.equal(task.phase, state.current_phase)
  assert.notEqual(task.status, 'APPROVED')
})

test('no future phase is started', () => {
  const state = read('state/project_state.json')
  for (const phase of ['PHASE_03', 'PHASE_04', 'PHASE_05', 'PHASE_06', 'PHASE_07']) {
    assert.equal(state.phase_status[phase], 'NOT_STARTED', phase + ' must not have begun')
  }
})
