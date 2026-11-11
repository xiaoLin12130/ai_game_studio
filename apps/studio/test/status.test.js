const { test } = require('node:test')
const assert = require('node:assert/strict')
const { classifyProbeError, isReady, INITIAL_STATE, STATUS_LABEL } = require('../dist/shared/status.js')

test('every status has a user-facing label', () => {
  const statuses = ['UNCHECKED', 'CHECKING', 'READY', 'UNAVAILABLE', 'FAILED', 'TIMEOUT', 'UNKNOWN']
  for (const status of statuses) assert.ok(STATUS_LABEL[status], 'missing label for ' + status)
})

test('a missing module is classified as a missing runtime', () => {
  const result = classifyProbeError("Error: Cannot find module 'x'\n  at ...")
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.detail.code, 'BINARY_MISSING')
})

test('a missing profile is classified separately from a missing binary', () => {
  const result = classifyProbeError('dsh: profile "nope" does not exist; create it with ...')
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.detail.code, 'PROFILE_MISSING')
})

test('an unusable home directory is classified', () => {
  const result = classifyProbeError('node:fs: ENOTDIR: not a directory, mkdir ...')
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.detail.code, 'HOME_UNUSABLE')
})

test('a corrupt profile manifest is classified', () => {
  const result = classifyProbeError('SyntaxError: Unexpected token } in JSON at position 3 is not valid JSON')
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.detail.code, 'PROFILE_MANIFEST_INVALID')
})

test('an unknown provider route is classified', () => {
  const result = classifyProbeError('no adapter registered for provider "commandcode"')
  assert.equal(result.status, 'FAILED')
  assert.equal(result.detail.code, 'ROUTE_UNKNOWN')
})

test('a degraded profile bundle is classified', () => {
  const result = classifyProbeError('initialize timed out after 8000ms; stderr tail: dsh: skipping profile bundle "x"')
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.detail.code, 'PROFILE_DEGRADED')
})

test('a plain timeout stays a timeout', () => {
  const result = classifyProbeError('initialize timed out after 200ms waiting for dsh profile "sdk"')
  assert.equal(result.status, 'TIMEOUT')
  assert.equal(result.detail.code, 'TIMEOUT')
})

test('the generic transport message keeps the first line for diagnostics', () => {
  const result = classifyProbeError('dsh profile "sdk": JSON-RPC input closed\nexit code: 1')
  assert.equal(result.status, 'FAILED')
  assert.equal(result.detail.code, 'INIT_FAILED')
  assert.match(result.detail.raw, /JSON-RPC input closed/)
})

test('an empty failure is unknown, not ready', () => {
  const result = classifyProbeError('')
  assert.equal(result.status, 'UNKNOWN')
})

test('readiness requires a status and a server identity', () => {
  assert.equal(isReady({ ...INITIAL_STATE, status: 'READY', serverInfo: { name: 'x', version: '1' } }), true)
  assert.equal(isReady({ ...INITIAL_STATE, status: 'READY', serverInfo: null }), false)
  assert.equal(isReady({ ...INITIAL_STATE, status: 'FAILED', serverInfo: { name: 'x', version: '1' } }), false)
  assert.equal(isReady(INITIAL_STATE), false)
})
