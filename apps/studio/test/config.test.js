const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateConfig, loadConfig, saveConfig, DEFAULT_CONFIG, CONFIG_VERSION, configFilePath } = require('../dist/main/config.js')

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-config-'))

test('defaults exist so a first launch needs no file', () => {
  const dir = tempDir()
  const loaded = loadConfig(dir)
  assert.equal(loaded.recovered, false)
  assert.equal(loaded.note, null)
  assert.deepEqual(loaded.config, DEFAULT_CONFIG)
  assert.equal(fs.existsSync(configFilePath(dir)), false, 'loading must not create the file')
})

test('a valid file round-trips through save and load', () => {
  const dir = tempDir()
  const config = structuredClone(DEFAULT_CONFIG)
  config.dsh.profile = 'sdk-minimal'
  config.dsh.probeTimeoutMs = 20000
  config.ui.autoProbeOnStart = false
  saveConfig(dir, config)
  const loaded = loadConfig(dir)
  assert.equal(loaded.recovered, false)
  assert.deepEqual(loaded.config, config)
})

test('a corrupt file is moved aside, defaults are used, and the user is told', () => {
  const dir = tempDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configFilePath(dir), '{ this is not json')
  const loaded = loadConfig(dir)
  assert.equal(loaded.recovered, true)
  assert.match(loaded.note, /not valid JSON/)
  assert.deepEqual(loaded.config, DEFAULT_CONFIG)
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, 'the broken file must be preserved for inspection')
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ this is not json')
})

test('validation rejects out-of-range timeouts and keeps the default', () => {
  const { config, problems } = validateConfig({ dsh: { probeTimeoutMs: 10 } })
  assert.equal(config.dsh.probeTimeoutMs, DEFAULT_CONFIG.dsh.probeTimeoutMs)
  assert.ok(problems.some((p) => p.includes('probeTimeoutMs')))
})

test('validation coerces a non-object into defaults with a problem', () => {
  const { config, problems } = validateConfig('nope')
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.equal(problems.length, 1)
})

test('unknown config versions are reported, not silently accepted', () => {
  const { problems } = validateConfig({ version: 99 })
  assert.ok(problems.some((p) => p.includes('unknown config version')))
})

test('a configured dsh entry is preserved and trimmed', () => {
  const { config, problems } = validateConfig({ dsh: { entryPath: '  dsh/bin.js  ' } })
  assert.equal(config.dsh.entryPath, 'dsh/bin.js')
  assert.equal(problems.length, 0)
  assert.equal(config.version, CONFIG_VERSION)
})
