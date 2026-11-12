/**
 * The watcher that proves every runtime a scenario starts has exited.
 *
 * Two failures are expensive enough to pin down without spawning the installed app:
 *  - `stop()` setting a flag but not draining the query in flight, so an identity discovered
 *    at exit is lost and a leaked runtime reads as gone;
 *  - a discovery error being swallowed, so "could not look" reads as "nothing found".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityWatcher, verifyIdentities } from '../scripts/lib/identity-watcher.mjs'

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const identity = (pid = 11, creationMs = 111) => ({ pid, creationMs, capturedAt: '2026-01-01T00:00:00.000Z', source: 'parent-and-bin' })
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('stop waits for the discovery still in flight and keeps what it found', async () => {
  const gate = deferred()
  const watcher = createIdentityWatcher({
    appPid: 1,
    binMarker: 'marker',
    discover: () => gate.promise,
    intervalMs: 5,
  })

  let settled = false
  const stopping = watcher.stop().then((identities) => {
    settled = true
    return identities
  })

  await flush()
  assert.equal(settled, false, 'stop must not resolve before the in-flight query settles')

  gate.resolve({ ok: true, identities: [identity(11, 111)] })
  const identities = await stopping
  assert.equal(identities.length, 1, 'the identity found at exit must still be recorded')
  assert.equal(identities[0].pid, 11)
  assert.equal(identities[0].creationMs, 111)
})

test('a discovery error is recorded, and doubt never reads as a clean check', async () => {
  const watcher = createIdentityWatcher({
    appPid: 1,
    binMarker: 'marker',
    discover: async () => ({ ok: false, error: 'wmi unavailable' }),
    intervalMs: 5,
  })

  const identities = await watcher.stop()
  assert.deepEqual(identities, [])
  assert.deepEqual(watcher.errors, ['wmi unavailable'], 'the failed query must stay observable')

  const verdicts = await verifyIdentities(identities, async () => ({ status: 'ABSENT' }), watcher.errors)
  assert.equal(verdicts.allGone, false, 'a watcher error must fail the check even with no identities')
})

test('the watcher keeps one entry per (pid, creationMs)', async () => {
  const same = identity(7, 70)
  const watcher = createIdentityWatcher({
    appPid: 1,
    binMarker: 'marker',
    discover: async () => ({ ok: true, identities: [same, { ...same }] }),
    intervalMs: 5,
  })

  const identities = await watcher.stop()
  assert.equal(identities.length, 1, 'the same runtime seen twice is one runtime')
})

test('verifyIdentities passes only when every captured runtime is ABSENT and nothing failed', async () => {
  const seen = [identity(1, 10), identity(2, 20)]
  const verdicts = await verifyIdentities(seen, async (id) => ({ status: 'ABSENT', pid: id.pid }), [])
  assert.equal(verdicts.count, 2)
  assert.deepEqual(verdicts.statuses, ['ABSENT', 'ABSENT'])
  assert.equal(verdicts.allGone, true)
})

test('PRESENT, FAILED and UNKNOWN are never a pass', async () => {
  const seen = [identity(1, 10), identity(2, 20), identity(3, 30)]
  for (const status of ['PRESENT', 'FAILED', 'UNKNOWN']) {
    const verdicts = await verifyIdentities(seen, async () => ({ status }), [])
    assert.equal(verdicts.allGone, false, status + ' must not count as gone')
  }
})

test('an empty result cannot prove that nothing leaked', async () => {
  const verdicts = await verifyIdentities([], async () => ({ status: 'ABSENT' }), [])
  assert.equal(verdicts.count, 0)
  assert.equal(verdicts.allGone, false, 'seeing nothing is not proof that nothing exists')
})
