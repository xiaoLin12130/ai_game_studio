/**
 * The task state machine is the thing that stops the app from lying about a task.
 * These tests pin the edges that matter: success is terminal, failure needs a new attempt,
 * and a resumed task has to pass through RESUMING.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  TRANSITIONS,
  TERMINAL,
  ACTIONS_FOR,
  canTransition,
  assertTransition,
  isTerminal,
  statusForAction,
  IllegalTransitionError,
} = require('../dist/main/tasks/machine.js')

test('the legal edges are exactly the ones we intend', () => {
  assert.equal(canTransition('CREATED', 'QUEUED'), true)
  assert.equal(canTransition('QUEUED', 'RUNNING'), false, 'queued work must be prepared first')
  assert.equal(canTransition('QUEUED', 'PREPARING'), true)
  assert.equal(canTransition('RUNNING', 'INTERRUPTED'), true, 'a runtime can die without us asking it to')
  assert.equal(canTransition('RUNNING', 'INTERRUPTING'), true, 'a user stop still goes through INTERRUPTING')
  assert.equal(canTransition('RUNNING', 'INTERRUPTING'), true)
  assert.equal(canTransition('INTERRUPTING', 'INTERRUPTED'), true)
  assert.equal(canTransition('INTERRUPTED', 'RUNNING'), false, 'a resume must pass through RESUMING')
  assert.equal(canTransition('INTERRUPTED', 'RESUMING'), true)
  assert.equal(canTransition('RESUMING', 'RUNNING'), true)
  assert.equal(canTransition('VERIFYING', 'SUCCEEDED'), true)
  assert.equal(canTransition('SUCCEEDED', 'RUNNING'), false)
  assert.equal(canTransition('FAILED', 'RUNNING'), false, 'a retry needs a new attempt via QUEUED')
  assert.equal(canTransition('FAILED', 'QUEUED'), true)
})

test('terminal states never move again', () => {
  for (const status of TERMINAL) {
    assert.deepEqual([...TRANSITIONS[status]], [], status + ' must have no outgoing edges')
    assert.equal(isTerminal(status), true)
  }
  assert.equal(isTerminal('RUNNING'), false)
  assert.equal(isTerminal('FAILED'), false, 'a failed task may be retried, so it is not terminal')
})

test('an illegal transition throws, and says which one', () => {
  assert.throws(() => assertTransition('SUCCEEDED', 'RUNNING'), (error) => {
    assert.equal(error instanceof IllegalTransitionError, true)
    assert.equal(error.from, 'SUCCEEDED')
    assert.equal(error.to, 'RUNNING')
    return true
  })
  assert.doesNotThrow(() => assertTransition('CREATED', 'QUEUED'))
})

test('the UI action list is derived from the same table, so they cannot drift', () => {
  for (const [status, actions] of Object.entries(ACTIONS_FOR)) {
    for (const action of actions) {
      assert.ok(statusForAction(status, action), status + ' offers ' + action + ' but it is not executable')
    }
  }
  assert.deepEqual([...ACTIONS_FOR.RUNNING], ['stop'])
  assert.deepEqual([...ACTIONS_FOR.INTERRUPTED], ['resume', 'cancel'])
  assert.deepEqual([...ACTIONS_FOR.FAILED], ['retry', 'cancel'])
  assert.deepEqual([...ACTIONS_FOR.SUCCEEDED], [], 'a succeeded task offers no actions')
})

test('actions map to the states a user would expect', () => {
  assert.equal(statusForAction('CREATED', 'start'), 'QUEUED')
  assert.equal(statusForAction('RUNNING', 'stop'), 'INTERRUPTING')
  assert.equal(statusForAction('INTERRUPTED', 'resume'), 'RESUMING')
  assert.equal(statusForAction('FAILED', 'retry'), 'QUEUED')
  assert.equal(statusForAction('RUNNING', 'start'), null, 'a running task cannot be started again')
  assert.equal(statusForAction('SUCCEEDED', 'cancel'), null)
})
