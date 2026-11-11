/**
 * The OS-level half of the lifecycle: finding a real stray process, proving it is ours,
 * terminating it, and confirming with the operating system that it is gone.
 *
 * These tests spawn a real child process and let the real PowerShell/CIM path and the
 * real taskkill path do the work. Nothing here is mocked — a passing run means an actual
 * process existed, was terminated, and no longer appears in the process table.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createProcessTable, createRuntimeProcessTerminator } = require('../dist/main/dsh/processes.js')

const table = createProcessTable()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Spawn a live process whose command line carries the marker we match on. */
function spawnMarker(markerPath) {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', markerPath], { stdio: 'ignore' })
}

async function waitFor(predicate, timeoutMs = 20000, intervalMs = 250) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

const killQuietly = (child) => {
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

test('a real stray process is found, verified, terminated and confirmed gone', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stray-'))
  const child = spawnMarker(home)
  try {
    // 1. The OS really sees it, matched by our DSH-home marker.
    const appeared = await waitFor(() => table.findRuntimeProcesses(home).status === 'PRESENT')
    assert.equal(appeared, true, 'the spawned process should appear in the process table')
    const before = table.findRuntimeProcesses(home)
    assert.ok(before.pids.includes(child.pid), 'the table should report the real PID: ' + JSON.stringify(before))

    // 2. Ownership is re-verified through the command line, not assumed from the PID.
    const inspected = table.inspectProcess(child.pid)
    assert.equal(inspected.found, true)
    assert.ok(String(inspected.commandLine).includes(home), 'ownership evidence must name this DSH home')

    // 3. Terminate, then re-query the table: success means the OS says ABSENT.
    const terminate = createRuntimeProcessTerminator({ table })
    const result = await terminate(home, 15000)
    assert.equal(result.attempted, true)
    assert.ok(result.killedPids.includes(child.pid), 'the verified PID should be terminated: ' + JSON.stringify(result))
    assert.equal(result.succeeded, true, JSON.stringify(result))
    assert.equal(table.findRuntimeProcesses(home).status, 'ABSENT')
  } finally {
    killQuietly(child)
  }
})

test('a process that does not carry the marker is neither matched nor terminated', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-other-'))
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    await sleep(500)
    const found = table.findRuntimeProcesses(home)
    assert.equal(found.status, 'ABSENT', 'an unrelated process must not match: ' + JSON.stringify(found))

    const terminate = createRuntimeProcessTerminator({ table })
    const result = await terminate(home, 3000)
    assert.equal(table.inspectProcess(other.pid).found, true, 'the unrelated process must still be alive')
    assert.equal(result.attempted, false, 'nothing to terminate, so nothing may be killed')
  } finally {
    killQuietly(other)
  }
})

test('the terminator reports failure instead of claiming success when the check cannot answer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fail-'))
  const brokenTable = {
    findRuntimeProcesses: () => ({ status: 'FAILED', pids: [], error: 'wmi unavailable', checkedAt: new Date().toISOString() }),
    inspectProcess: () => ({ found: false, pid: null, name: null, commandLine: null, error: 'wmi unavailable' }),
  }
  const terminate = createRuntimeProcessTerminator({ table: brokenTable })
  const result = await terminate(home, 1000)
  assert.equal(result.attempted, false, 'an inconclusive check is not a licence to kill')
  assert.equal(result.succeeded, false)
  assert.match(String(result.error), /wmi unavailable/)
})
