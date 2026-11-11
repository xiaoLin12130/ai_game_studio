/**
 * Runtime identity checks, against a scripted process table.
 *
 * The bug these tests exist for: the DSH home is passed as an environment variable, so a
 * live runtime's command line does not contain it. A home-based matcher therefore reports
 * ABSENT while the process is running, which reads as "nothing leaked" — the most dangerous
 * possible answer. Identity is the (pid, creation time) pair captured from the parent
 * relationship instead, and anything unconfirmed is never reported as gone.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { captureRuntimeIdentity, verifyRuntimeIdentity } = require('../dist/main/dsh/processes.js')

const MARKER = '@deepseek-ai\\dsh\\lib\\bin.js'

/** A table whose answers the test controls. */
function tableWith(options) {
  return {
    async list() {
      return { ok: true, processes: options.processes ?? [], error: null, durationMs: 1 }
    },
    async listChildren() {
      if (options.childrenError) return { ok: false, processes: [], error: options.childrenError, durationMs: 1 }
      return { ok: true, processes: options.children ?? [], error: null, durationMs: 1 }
    },
    async inspect() {
      if (options.inspectError) return { found: false, process: null, error: options.inspectError, durationMs: 1 }
      if (!options.found) return { found: false, process: null, error: null, durationMs: 1 }
      return {
        found: true,
        process: {
          pid: options.pid ?? 4242,
          parentPid: 1,
          name: 'node.exe',
          creationMs: options.creationMs ?? null,
          commandLine: options.commandLine ?? '',
        },
        error: null,
        durationMs: 1,
      }
    },
  }
}

const identity = (creationMs = 1000) => ({ pid: 4242, creationMs, capturedAt: new Date().toISOString(), source: 'parent-and-bin' })

test('a live runtime whose command line has no DSH home is still reported PRESENT', async () => {
  // This is the exact shape the old matcher got wrong.
  const table = tableWith({ found: true, creationMs: 1000, commandLine: '"node.exe" "...\\dsh\\lib\\bin.js" --profile sdk' })
  const verdict = await verifyRuntimeIdentity(table, identity(1000), 4000)
  assert.equal(verdict.status, 'PRESENT')
  assert.equal(verdict.pid, 4242)
  assert.equal(verdict.reason, 'the captured runtime is still running')
})

test('the home string never appears in a running runtime command line', async () => {
  const commandLine = '"C:\\app\\AI Game Studio.exe" "C:\\app\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile sdk'
  assert.equal(commandLine.includes('dsh-home'), false, 'the home is an env var, not an argument')
  const table = tableWith({ found: true, creationMs: 1000, commandLine })
  assert.equal((await verifyRuntimeIdentity(table, identity(1000), 4000)).status, 'PRESENT')
})

test('an exited runtime is ABSENT', async () => {
  const table = tableWith({ found: false })
  const verdict = await verifyRuntimeIdentity(table, identity(1000), 4000)
  assert.equal(verdict.status, 'ABSENT')
  assert.equal(verdict.reason, 'the pid no longer exists')
})

test('a reused pid is ABSENT, and says so', async () => {
  const table = tableWith({ found: true, creationMs: 9999, commandLine: 'something else entirely' })
  const verdict = await verifyRuntimeIdentity(table, identity(1000), 4000)
  assert.equal(verdict.status, 'ABSENT')
  assert.match(verdict.reason, /reused/)
  assert.equal(verdict.observedCreationMs, 9999)
})

test('a failed query is FAILED, never ABSENT', async () => {
  const table = tableWith({ inspectError: 'wmi unavailable' })
  const verdict = await verifyRuntimeIdentity(table, identity(1000), 4000)
  assert.equal(verdict.status, 'FAILED')
  assert.match(verdict.reason, /wmi unavailable/)
})

test('an incomparable creation time is UNKNOWN, never ABSENT', async () => {
  const missingObserved = tableWith({ found: true, creationMs: null })
  assert.equal((await verifyRuntimeIdentity(missingObserved, identity(1000), 4000)).status, 'UNKNOWN')

  const missingCaptured = tableWith({ found: true, creationMs: 1000 })
  assert.equal((await verifyRuntimeIdentity(missingCaptured, identity(null), 4000)).status, 'UNKNOWN')
})

test('capture refuses to pick between two candidates in the same parent', async () => {
  const table = tableWith({
    children: [
      { pid: 11, parentPid: 4242, name: 'node.exe', creationMs: 1, commandLine: MARKER },
      { pid: 12, parentPid: 4242, name: 'node.exe', creationMs: 2, commandLine: MARKER },
    ],
  })
  const capture = await captureRuntimeIdentity(table, { parentPid: 4242, binMarker: MARKER, deadline: Date.now() + 3000 })
  assert.equal(capture.status, 'failed')
  assert.match(String(capture.error), /ambiguous/)
  assert.equal(capture.identity, null, 'an ambiguous capture must not produce an identity to kill')
})

test('capture pins exactly one runtime and keeps its creation time', async () => {
  const table = tableWith({
    children: [
      { pid: 11, parentPid: 4242, name: 'node.exe', creationMs: 111, commandLine: MARKER },
      { pid: 99, parentPid: 4242, name: 'powershell.exe', creationMs: 999, commandLine: 'Get-CimInstance' },
    ],
  })
  const capture = await captureRuntimeIdentity(table, { parentPid: 4242, binMarker: MARKER, deadline: Date.now() + 3000 })
  assert.equal(capture.status, 'captured')
  assert.equal(capture.identity.pid, 11)
  assert.equal(capture.identity.creationMs, 111)
  assert.equal(capture.identity.source, 'parent-and-bin')
})
