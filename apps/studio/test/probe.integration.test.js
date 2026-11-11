/**
 * Integration tests against the real DSH runtime bundled with the SDK.
 *
 * These are not mocks: they spawn the actual `dsh` process on a temporary home. They are
 * cheap (about two seconds each) because the probe sends no prompt and spends no quota.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProbe, exitCodeFromMessage } = require('../dist/main/dsh/probe.js')
const { resolveDshEntry, bundledDsh } = require('../dist/main/dsh/locate.js')

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dsh-'))

test('the bundled dsh entry resolves without spawning anything', () => {
  const bundled = bundledDsh()
  assert.equal(bundled.problem, null)
  assert.ok(bundled.entry && bundled.entry.endsWith('.js'))
  assert.match(String(bundled.version), /^\d+\.\d+\.\d+/, 'a real package version must be readable')
})

test('a healthy runtime is reported READY with a server identity', async () => {
  const home = tempHome()
  const outcome = await runProbe({
    dshHome: home,
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 60000,
    cwd: home,
    entry: resolveDshEntry(null),
  }).done
  assert.equal(outcome.status, 'READY', JSON.stringify(outcome.detail))
  assert.equal(outcome.detail.code, 'HANDSHAKE_OK')
  assert.equal(outcome.serverInfo.name, 'deepseek-harness-sdk-runtime')
  assert.ok(outcome.durationMs > 0)
  assert.ok(Number.isInteger(outcome.runtimeExitCode), 'the runtime exit code should be observed')
})

test('a missing profile is UNAVAILABLE and says which one', async () => {
  const home = tempHome()
  const outcome = await runProbe({
    dshHome: home,
    profile: 'definitely-not-a-profile',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 20000,
    cwd: home,
    entry: resolveDshEntry(null),
  }).done
  assert.equal(outcome.status, 'UNAVAILABLE')
  assert.equal(outcome.detail.code, 'PROFILE_MISSING')
  assert.match(String(outcome.detail.raw), /profile/i)
})

test('a configured entry that does not exist fails without spawning', async () => {
  const home = tempHome()
  const outcome = await runProbe({
    dshHome: home,
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 5000,
    cwd: home,
    entry: resolveDshEntry(path.join(home, 'no-such-dsh.js')),
  }).done
  assert.equal(outcome.status, 'UNAVAILABLE')
  assert.equal(outcome.detail.code, 'BINARY_MISSING')
  assert.equal(outcome.durationMs < 1000, true, 'a missing binary must fail fast')
})

test('an impossible deadline is TIMEOUT, not a false pass', async () => {
  const home = tempHome()
  const outcome = await runProbe({
    dshHome: home,
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 5,
    cwd: home,
    entry: resolveDshEntry(null),
  }).done
  assert.equal(outcome.status, 'TIMEOUT')
  assert.equal(outcome.detail.code, 'TIMEOUT')
  assert.equal(outcome.serverInfo, null)
})

test('the exit code is only taken from the documented message line', () => {
  assert.equal(exitCodeFromMessage('dsh profile "sdk": exited\nexit code: 0'), 0)
  assert.equal(exitCodeFromMessage('dsh profile "sdk": exited\nexit code: 1'), 1)
  assert.equal(exitCodeFromMessage('JSON-RPC input closed'), null)
  assert.equal(exitCodeFromMessage(''), null)
  assert.equal(exitCodeFromMessage(null), null)
  assert.equal(exitCodeFromMessage(42), null)
})
