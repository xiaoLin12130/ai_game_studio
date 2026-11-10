/**
 * Process inspection with an explicit three-state result.
 *
 * PHASE 00-R1 review finding: the previous version returned `[]` whenever the
 * PowerShell query threw, so "could not look" was indistinguishable from "nothing
 * is running" — a broken check read as a green tick. This module never collapses
 * failure into absence.
 *
 *   PROCESS_PRESENT       — query succeeded, matching processes exist
 *   PROCESS_ABSENT        — query succeeded, no matching process exists
 *   PROCESS_CHECK_FAILED  — the query itself failed; evidence is incomplete
 *
 * Matching is deliberately independent of the parent/child chain. On Windows an
 * orphan is re-parented, so a tree walk alone can report "gone" while an orphaned
 * runtime still runs. We therefore also match command-line markers, including the
 * isolation-unique DSH home path.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * Unique marker embedded in our own enumeration command line. Without it the check
 * observes the very process performing the check and reports a phantom leftover.
 */
const PROC_QUERY_SENTINEL = `dsh-proc-probe-${crypto.randomUUID()}`

export const PROC = {
  PRESENT: 'PROCESS_PRESENT',
  ABSENT: 'PROCESS_ABSENT',
  FAILED: 'PROCESS_CHECK_FAILED',
}

/**
 * Snapshot every process: `{status, processes, error}`.
 * Non-zero exit, unparsable output, or an empty table is FAILED — never `[]` as
 * a stand-in for "nothing running".
 */
export function snapshotProcesses() {
  if (process.platform !== 'win32') {
    return { status: PROC.FAILED, processes: [], error: `unsupported platform: ${process.platform}` }
  }
  const script = [
    // A string assignment, not a comment: the whole script is joined onto one
    // logical line, so `#` would swallow every statement after it. The value also
    // makes this exact process recognisable in its own command line.
    `$__probeSentinel = "${PROC_QUERY_SENTINEL}";`,
    '$ErrorActionPreference = "Stop";',
    'try {',
    '  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine);',
    '  [pscustomobject]@{ ok = $true; data = $rows } | ConvertTo-Json -Compress -Depth 4',
    '} catch {',
    '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
    '}',
  ].join(' ')

  let raw
  try {
    raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    return { status: PROC.FAILED, processes: [], error: `powershell spawn failed: ${error?.message ?? error}` }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: PROC.FAILED, processes: [], error: `unparsable process list: ${String(raw).slice(0, 200)}` }
  }
  if (!parsed?.ok) {
    return { status: PROC.FAILED, processes: [], error: `cim query failed: ${parsed?.error ?? 'unknown'}` }
  }
  const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data ? [parsed.data] : []
  if (rows.length === 0) {
    return { status: PROC.FAILED, processes: [], error: 'process table came back empty' }
  }
  return { status: PROC.PRESENT, processes: rows, error: null }
}

/** Every descendant of `rootPid` in one snapshot. */
function descendantsOf(processes, rootPid) {
  const byParent = new Map()
  for (const proc of processes) {
    const parent = Number(proc.ParentProcessId)
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(proc)
  }
  const out = []
  const queue = [Number(rootPid)]
  const seen = new Set(queue)
  while (queue.length) {
    const pid = queue.shift()
    for (const child of byParent.get(pid) ?? []) {
      const childPid = Number(child.ProcessId)
      if (seen.has(childPid)) continue
      seen.add(childPid)
      out.push(child)
      queue.push(childPid)
    }
  }
  return out
}

/**
 * Find processes belonging to one isolated runtime, including orphans.
 *
 * @param {object} options
 * @param {string} options.dshHome absolute, per-run DSH home (unique isolation marker)
 * @param {number} [options.rootPid] the process expected to own the runtime
 * @param {string[]} [options.commandMarkers] extra identifying substrings (probe script, MCP server)
 * @returns {{status: string, matches: Array, error: string|null, checkedAt: string}}
 */
export function findRuntimeProcesses({ dshHome, rootPid = process.pid, commandMarkers = [] }) {
  const snapshot = snapshotProcesses()
  if (snapshot.status === PROC.FAILED) {
    return { status: PROC.FAILED, matches: [], error: snapshot.error, checkedAt: new Date().toISOString() }
  }

  const homeVariants = dshHome
    ? [dshHome, dshHome.replace(/\\/g, '/'), dshHome.replace(/\//g, '\\')]
    : []
  const descendants = new Set(descendantsOf(snapshot.processes, rootPid).map((p) => Number(p.ProcessId)))

  const matches = snapshot.processes.filter((proc) => {
    const pid = Number(proc.ProcessId)
    if (pid === Number(rootPid)) return false
    const cmd = String(proc.CommandLine ?? '')
    // Never let the enumeration observe itself, and ignore the console host Windows
    // attaches to it — neither belongs to the runtime under test.
    if (cmd.includes(PROC_QUERY_SENTINEL)) return false
    if (String(proc.Name ?? '').toLowerCase() === 'conhost.exe') return false
    if (descendants.has(pid)) return true
    if (homeVariants.some((variant) => cmd.includes(variant))) return true
    return commandMarkers.some((marker) => Boolean(marker) && cmd.includes(marker))
  })

  return {
    status: matches.length > 0 ? PROC.PRESENT : PROC.ABSENT,
    matches: matches.map((proc) => ({
      pid: Number(proc.ProcessId),
      parentPid: Number(proc.ParentProcessId),
      name: String(proc.Name ?? ''),
      commandline: String(proc.CommandLine ?? '').slice(0, 400),
      matchedVia: descendants.has(Number(proc.ProcessId)) ? 'descendant-tree' : 'command-line-marker',
    })),
    error: null,
    checkedAt: new Date().toISOString(),
  }
}

/**
 * Poll until no runtime process remains.
 * @returns {{status: string, waitedMs: number, lastMatches: Array, error: string|null}}
 * `PROCESS_CHECK_FAILED` is never reported as gone.
 */
export async function waitForRuntimeGone({
  dshHome,
  rootPid = process.pid,
  commandMarkers = [],
  boundMs = 20000,
  intervalMs = 250,
}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < boundMs) {
    last = findRuntimeProcesses({ dshHome, rootPid, commandMarkers })
    if (last.status === PROC.ABSENT) {
      return { status: PROC.ABSENT, waitedMs: Date.now() - started, lastMatches: [], error: null }
    }
    if (last.status === PROC.FAILED) {
      return { status: PROC.FAILED, waitedMs: Date.now() - started, lastMatches: [], error: last.error }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  last = findRuntimeProcesses({ dshHome, rootPid, commandMarkers })
  return { status: last.status, waitedMs: Date.now() - started, lastMatches: last.matches, error: last.error }
}

/** True when a pid is alive. EPERM means it exists but is not ours. */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Clear a stale profile writer lock.
 *
 * `dsh-atomic-write` creates `profiles/node_modules.lock` with `wx`, never checks
 * whether the recorded pid is alive, and gives up after its 2000 ms deadline. A
 * boot that dies holding the lock therefore fails the next boot, and the SDK above
 * it only reports "JSON-RPC input closed".
 *
 * @param {string} dshHome absolute DSH home
 */
export function clearStaleProfileLock(dshHome) {
  const lockPath = `${dshHome.replace(/\\/g, '/')}/profiles/node_modules.lock`
  const result = { checked: false, cleared: false, stalePid: null, path: lockPath, error: null }
  let raw
  try {
    raw = fs.readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') result.error = String(error?.message ?? error)
    return result
  }
  result.checked = true
  const pid = Number.parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(pid)) return result
  result.stalePid = pid
  if (isPidAlive(pid)) return result
  try {
    fs.unlinkSync(lockPath)
    result.cleared = true
  } catch (error) {
    result.error = String(error?.message ?? error)
  }
  return result
}

/** OS-level inventory recorded with every probe run. */
export function runtimeVersionFacts() {
  return {
    platform: process.platform,
    osVersion: process.getSystemVersion?.() ?? null,
    node: process.version,
    arch: process.arch,
    pid: process.pid,
    execPath: process.execPath,
  }
}
