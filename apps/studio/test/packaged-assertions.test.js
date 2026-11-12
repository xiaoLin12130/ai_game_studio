/**
 * The packaged scenario assertions, tested as plain functions.
 *
 * These exist because the harness used to accept ['SUCCEEDED', 'FAILED'] as a successful
 * resume: a task that failed after resuming still counted as a pass. The rule is now that
 * only SUCCEEDED is success, and this pins that down without spending model quota.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

/**
 * The exact predicate the packaged harness uses. Kept as a function so the rule can be
 * tested directly instead of being inferred from a JSON file.
 */
const taskSucceeded = (finalStatus) => finalStatus === 'SUCCEEDED'

test('only SUCCEEDED counts as a successful task', () => {
  assert.equal(taskSucceeded('SUCCEEDED'), true)
})

test('every other terminal or in-flight state is a failure', () => {
  for (const status of ['FAILED', 'INTERRUPTED', 'CANCELLED', 'RUNNING', 'QUEUED', 'VERIFYING', 'UNKNOWN', '']) {
    assert.equal(taskSucceeded(status), false, status + ' must not count as success')
  }
})

test('a missing status is a failure, not a pass', () => {
  assert.equal(taskSucceeded(undefined), false)
  assert.equal(taskSucceeded(null), false)
})

test('the packaged harness uses this exact rule for A, B and C', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-tasks-packaged.mjs'), 'utf8')
  const strict = source.match(/taskSucceeded: [^,\n]*finalStatus === 'SUCCEEDED'/g) ?? []
  assert.equal(strict.length, 3, 'A, B and C must each assert strict success: ' + strict.length)
  assert.equal(/\[\s*'SUCCEEDED'\s*,\s*'FAILED'\s*\]/.test(source), false, 'no lenient status list may remain')
})
