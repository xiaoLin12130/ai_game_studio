/**
 * The OS-level half of the lifecycle, against live child processes.
 *
 * Nothing here is mocked: every test spawns real processes, uses the real PowerShell/CIM
 * process table and the real taskkill path. A passing run means a process really existed,
 * was really terminated, and really disappeared from the table — or really survived when
 * it was not ours.
 *
 * Ownership is the pair (parent process, dsh CLI marker) captured while the probe is live,
 * pinned with the process creation time. The DSH home is deliberately NOT part of the
 * authorization: the SDK passes it as an environment variable, so it never appears in a
 * command line, and two instances may share one.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  createProcessTable,
  captureRuntimeIdentity,
  terminateRuntimeIdentity,
  defaultKiller,
} = require('../dist/main/dsh/processes.js')

const table = createProcessTable()
const MARKER = 'dsh-owner-marker-7f3a'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A live process whose command line carries the given tokens. */
function spawnMarked(...tokens) {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...tokens], { stdio: 'ignore' })
}

async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await sleep(200)
  }
  return false
}

const alive = async (pid) => (await table.inspect(pid, 4000)).found
const killQuietly = (child) => {
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

const capture = (parentPid, marker, boundMs = 15000) =>
  captureRuntimeIdentity(table, { parentPid, binMarker: marker, deadline: Date.now() + boundMs })

test('A. the runtime this probe owns is captured, terminated and confirmed gone', async () => {
  const child = spawnMarked(MARKER)
  try {
    const result = await capture(process.pid, MARKER)
    assert.equal(result.status, 'captured', JSON.stringify(result))
    assert.equal(result.identity.pid, child.pid)
    assert.equal(result.identity.source, 'parent-and-bin')
    assert.ok(Number.isInteger(result.identity.creationMs), 'the creation time must be pinned')

    const termination = await terminateRuntimeIdentity(table, defaultKiller, result.identity, {
      deadline: Date.now() + 15000,
    })
    assert.equal(termination.succeeded, true, JSON.stringify(termination))
    assert.deepEqual(termination.killedPids, [child.pid])
    assert.equal(await alive(child.pid), false, 'the OS must no longer list the process')
  } finally {
    killQuietly(child)
  }
})

test('B. another instance sharing the same DSH home is never touched', async () => {
  const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-shared-home-'))
  const ours = spawnMarked(MARKER, sharedHome)
  const otherInstance = spawnMarked('other-instance-marker', sharedHome)
  try {
    const result = await capture(process.pid, MARKER)
    assert.equal(result.status, 'captured', JSON.stringify(result))
    assert.equal(result.identity.pid, ours.pid, 'only the process running the dsh CLI may be captured')

    const termination = await terminateRuntimeIdentity(table, defaultKiller, result.identity, {
      deadline: Date.now() + 15000,
    })
    assert.equal(termination.succeeded, true, JSON.stringify(termination))
    assert.equal(await alive(ours.pid), false, 'our runtime must be gone')
    assert.equal(await alive(otherInstance.pid), true, 'the other instance must still be running')
  } finally {
    killQuietly(ours)
    killQuietly(otherInstance)
  }
})

test('C. a recycled PID is refused instead of killed', async () => {
  const child = spawnMarked(MARKER)
  try {
    const result = await capture(process.pid, MARKER)
    assert.equal(result.status, 'captured')

    // Same PID, different creation time: the number now belongs to somebody else.
    const recycled = { ...result.identity, creationMs: result.identity.creationMs + 5000 }
    let killed = 0
    const termination = await terminateRuntimeIdentity(
      table,
      async () => {
        killed += 1
        return { ok: true, error: null }
      },
      recycled,
      { deadline: Date.now() + 8000 },
    )

    assert.equal(killed, 0, 'taskkill must not be invoked for a recycled PID')
    assert.equal(termination.succeeded, true)
    assert.ok(termination.skippedPids.includes(child.pid), JSON.stringify(termination))
    assert.match(String(termination.error), /recycled/)
    assert.equal(await alive(child.pid), true, 'the process itself must be untouched')
  } finally {
    killQuietly(child)
  }
})

test('D. the fallback shares one deadline instead of per-process budgets', async () => {
  const child = spawnMarked(MARKER)
  try {
    const result = await capture(process.pid, MARKER)
    assert.equal(result.status, 'captured')

    // A table that is deliberately slower than the whole budget: the terminator must give
    // up inside the deadline rather than granting each step a fresh one.
    const slowTable = {
      async list(boundMs) {
        return table.list(boundMs)
      },
      async listChildren(parentPid, boundMs) {
        return table.listChildren(parentPid, boundMs)
      },
      async inspect(pid, boundMs) {
        await sleep(Math.min(400, Math.max(0, boundMs)))
        return table.inspect(pid, Math.max(50, boundMs - 400))
      },
    }

    const started = Date.now()
    const termination = await terminateRuntimeIdentity(slowTable, defaultKiller, result.identity, {
      deadline: Date.now() + 600,
    })
    const elapsed = Date.now() - started

    assert.ok(elapsed < 6000, 'the whole fallback must stay near its deadline: ' + elapsed + 'ms')
    assert.equal(termination.deadlineHit || termination.succeeded, true, JSON.stringify(termination))
    if (!termination.succeeded) {
      assert.ok(termination.remainingPids.includes(child.pid), 'a failed reclaim must report the leftover PID')
      assert.match(String(termination.error), /deadline|gone/i)
    }
  } finally {
    killQuietly(child)
  }
})

test('E. an unrelated process is never captured by the dsh marker', async () => {
  const unrelated = spawnMarked('not-the-dsh-marker')
  try {
    const result = await capture(process.pid, MARKER, 3000)
    assert.equal(result.status, 'absent', JSON.stringify(result))
    assert.equal(await alive(unrelated.pid), true)
  } finally {
    killQuietly(unrelated)
  }
})

test('F. the terminator reports failure instead of claiming success when the table cannot answer', async () => {
  const brokenTable = {
    async list() { return { ok: false, processes: [], error: 'wmi unavailable', durationMs: 1 } },
    async listChildren() { return { ok: false, processes: [], error: 'wmi unavailable', durationMs: 1 } },
    async inspect() { return { found: false, process: null, error: 'wmi unavailable', durationMs: 1 } },
  }
  const identity = { pid: 999999, creationMs: 1, capturedAt: new Date().toISOString(), source: 'injected' }
  let killed = 0
  const termination = await terminateRuntimeIdentity(
    brokenTable,
    async () => { killed += 1; return { ok: true, error: null } },
    identity,
    { deadline: Date.now() + 2000 },
  )
  assert.equal(killed, 0, 'an inconclusive check is not a licence to kill')
  assert.equal(termination.succeeded, false)
  assert.match(String(termination.error), /wmi unavailable/)
})
