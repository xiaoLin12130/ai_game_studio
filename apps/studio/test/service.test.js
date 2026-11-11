/**
 * The service layer: one probe at a time, cancellable, and state pushed on every change.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DshConnectionService } = require('../dist/main/dsh/service.js')
const { DEFAULT_CONFIG } = require('../dist/main/config.js')

function makeService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-service-'))
  const events = []
  const logger = {
    path: path.join(dir, 'studio.log'),
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.dsh.probeTimeoutMs = overrides.timeoutMs ?? 60000
  const service = new DshConnectionService({
    logger,
    userDataDir: dir,
    readConfig: () => config,
    configRecovered: Boolean(overrides.recovered),
    configRecoveryNote: overrides.note ?? null,
  })
  return { service, events, dir }
}

test('the initial state is UNCHECKED and says so', () => {
  const { service } = makeService()
  const state = service.getState()
  assert.equal(state.status, 'UNCHECKED')
  assert.equal(state.detail.code, 'NOT_CHECKED')
  assert.equal(state.lastCheckedAt, null)
})

test('a real check moves CHECKING then READY and reports timing', async () => {
  const { service } = makeService()
  const seen = []
  service.on('state', (state) => seen.push(state.status))
  const final = await service.check('manual')
  assert.equal(seen[0], 'CHECKING')
  assert.equal(final.status, 'READY', JSON.stringify(final.detail))
  assert.ok(final.lastCheckedAt)
  assert.ok(final.lastDurationMs > 0)
  assert.equal(final.serverInfo.name, 'deepseek-harness-sdk-runtime')
  assert.equal(service.isChecking(), false)
})

test('a second check while one is running joins it instead of stacking runtimes', async () => {
  const { service, events } = makeService()
  const first = service.check('manual')
  const second = service.check('manual')
  await Promise.all([first, second])
  const starts = events.filter((entry) => entry.event === 'dsh.probe.start').length
  const joins = events.filter((entry) => entry.event === 'dsh.probe.join').length
  assert.equal(starts, 1, 'only one runtime may be spawned')
  assert.equal(joins, 1, 'the second request must be recorded as a join')
})

test('a recovered config is surfaced on the state instead of being swallowed', () => {
  const { service } = makeService({ recovered: true, note: 'config.json was not valid JSON' })
  const state = service.getState()
  assert.equal(state.configRecovered, true)
  assert.match(String(state.configRecoveryNote), /not valid JSON/)
})

test('the isolated home is created under user data when none is configured', () => {
  const { service, dir } = makeService()
  const home = service.resolveDshHome(DEFAULT_CONFIG)
  assert.equal(home, path.join(dir, 'dsh-home'))
  assert.equal(fs.existsSync(home), true)
})
