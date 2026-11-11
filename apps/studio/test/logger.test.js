const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLogger, redactFields, redactString, LOG_FILE } = require('../dist/main/logger.js')

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-log-'))

test('secret-looking keys are redacted at any depth', () => {
  const redacted = redactFields({
    ok: 'visible',
    apiKey: 'plain',
    nested: { token: 'abc', password: 'p', authorization: 'Bearer x' },
    list: [{ secret: 's' }],
  })
  assert.equal(redacted.ok, 'visible')
  assert.equal(redacted.apiKey, '<redacted>')
  assert.equal(redacted.nested.token, '<redacted>')
  assert.equal(redacted.nested.password, '<redacted>')
  assert.equal(redacted.nested.authorization, '<redacted>')
  assert.equal(redacted.list[0].secret, '<redacted>')
})

test('credential-shaped strings are scrubbed even under innocent keys', () => {
  // Built at runtime so this fixture is not itself a publishable credential-shaped string.
  const openAi = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
  const github = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'
  const scrubbed = redactString('key ' + openAi + ' and ' + github)
  assert.ok(!scrubbed.includes(openAi))
  assert.ok(!scrubbed.includes('ghp_'))
  assert.match(scrubbed, /<credential>/)
})

test('log lines are json, redacted, and carry the event name', () => {
  const dir = tempDir()
  const logger = createLogger(dir)
  const fakeKey = 'sk-' + 'shouldnotappear1234567890'
  logger.info('probe.start', { profile: 'sdk', apiKey: fakeKey })
  const lines = fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.event, 'probe.start')
  assert.equal(record.level, 'info')
  assert.equal(record.profile, 'sdk')
  assert.equal(record.apiKey, '<redacted>')
  assert.ok(!lines[0].includes('shouldnotappear'))
})

test('an oversized log is rotated instead of growing without bound', () => {
  const dir = tempDir()
  const file = path.join(dir, LOG_FILE)
  fs.writeFileSync(file, 'x'.repeat(2048))
  const logger = createLogger(dir, { maxBytes: 1024, keep: 2 })
  logger.info('after-rotation', {})
  assert.ok(fs.existsSync(file + '.1'), 'the old log must be kept as .1')
  assert.equal(fs.readFileSync(file + '.1', 'utf8').length, 2048)
  assert.ok(fs.readFileSync(file, 'utf8').includes('after-rotation'))
})
