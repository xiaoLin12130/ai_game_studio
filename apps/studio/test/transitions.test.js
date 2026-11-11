/**
 * State transitions with the real runtime: failure, recovery, and the guarantees that
 * make a stale failure impossible to mistake for a healthy state.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DshConnectionService } = require('../dist/main/dsh/service.js')
const { DEFAULT_CONFIG } = require('../dist/main/config.js')

function harness(dshOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transitions-'))
  const events = []
  const logger = {
    path: path.join(dir, 'studio.log'),
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
  }
  const config = structuredClone(DEFAULT_CONFIG)
  Object.assign(config.dsh, dshOverrides)
  const service = new DshConnectionService({
    logger,
    userDataDir: dir,
    readConfig: () => config,
    configRecovered: false,
    configRecoveryNote: null,
  })
  return { service, events, config }
}

test('a failure, a fix, and a successful re-check walk the whole state machine', async () => {
  const { service, config } = harness({ profile: 'definitely-not-a-profile' })
  const seen = []
  service.on('state', (state) => seen.push({ status: state.status, code: state.detail.code }))

  assert.equal(service.getState().status, 'UNCHECKED')

  const failed = await service.check('manual')
  assert.equal(failed.status, 'UNAVAILABLE')
  assert.equal(failed.detail.code, 'PROFILE_MISSING')
  assert.ok(failed.detail.raw, 'a failure must carry its raw cause for diagnostics')
  assert.equal(failed.serverInfo, null)

  // The user (or a fix) points the probe at a working profile, then re-checks.
  config.dsh.profile = 'sdk'
  const ready = await service.check('manual')

  assert.equal(ready.status, 'READY', JSON.stringify(ready.detail))
  assert.equal(ready.detail.code, 'HANDSHAKE_OK')
  assert.equal(ready.serverInfo.name, 'deepseek-harness-sdk-runtime')
  assert.equal(ready.detail.raw, undefined, 'the previous failure must not leak into READY')
  assert.equal(ready.runtimeExitCode !== null, true)

  assert.deepEqual(
    seen.map((entry) => entry.status),
    ['CHECKING', 'UNAVAILABLE', 'CHECKING', 'READY'],
    'the UI must see every transition, in order',
  )
  assert.deepEqual(
    seen.map((entry) => entry.code),
    ['PROBE_RUNNING', 'PROFILE_MISSING', 'PROBE_RUNNING', 'HANDSHAKE_OK'],
  )
})

test('a READY state can be re-checked without losing its identity', async () => {
  const { service } = harness()
  const first = await service.check('manual')
  assert.equal(first.status, 'READY')
  const second = await service.check('manual')
  assert.equal(second.status, 'READY')
  assert.equal(second.serverInfo.name, 'deepseek-harness-sdk-runtime')
  assert.ok(second.lastCheckedAt >= first.lastCheckedAt)
})

test('two overlapping checks still produce exactly one runtime', async () => {
  const { service, events } = harness()
  const [a, b] = await Promise.all([service.check('manual'), service.check('manual')])
  assert.equal(a.status, 'READY')
  assert.equal(b.status, 'READY')
  assert.equal(events.filter((entry) => entry.event === 'dsh.probe.start').length, 1)
  assert.equal(events.filter((entry) => entry.event === 'dsh.probe.join').length, 1)
})

test('the exported state always matches the last emitted state', async () => {
  const { service } = harness({ profile: 'definitely-not-a-profile' })
  let last = null
  service.on('state', (state) => { last = state })
  await service.check('manual')
  assert.deepEqual(service.getState(), last, 'what the UI renders must be the service state')
})
