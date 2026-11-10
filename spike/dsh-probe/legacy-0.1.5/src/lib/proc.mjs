/**
 * Child-process inspection used to prove that closing the SDK client really
 * terminates the DSH runtime process instead of only detaching the UI.
 *
 * The SDK keeps the child pid private, so the probe enumerates OS processes whose
 * parent is this probe process. That is the same fact an operator would check with
 * Task Manager, and it is the check AGENTS.md 5 demands: "timeout != stopped".
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

/** Enumerate direct children of this process on Windows via CIM. */
export function listChildProcesses() {
  if (process.platform !== 'win32') return []
  const script = [
    `$pid0 = ${process.pid};`,
    'Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid0" |',
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine |',
    'ConvertTo-Json -Compress -Depth 3',
  ].join(' ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    if (!out) return []
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** True when any live child of this process looks like a DSH runtime. */
export function hasLiveDshChild() {
  return listChildProcesses().some((proc) => {
    const cmd = String(proc.CommandLine ?? '')
    return /dsh|deepseek/i.test(cmd)
  })
}

/** Poll until no DSH child remains, or the bound elapses. */
export async function waitForNoDshChild(boundMs = 15000, intervalMs = 250) {
  const started = Date.now()
  while (Date.now() - started < boundMs) {
    if (!hasLiveDshChild()) return { gone: true, waitedMs: Date.now() - started }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { gone: !hasLiveDshChild(), waitedMs: Date.now() - started }
}

/** OS-level inventory for the environment section of the evidence file. */
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

/** True when a pid is currently alive on this machine. */
function isPidAlive(pid) {
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
 * Observed behaviour in PHASE 00: if a `dsh` profile boot dies between taking
 * `$DSH_HOME/profiles/node_modules.lock` and releasing it, every later launch
 * blocks until `atomic-write` times out, and the SDK reports only
 * `JSON-RPC input closed`. The lock file contains the owner pid, so a launcher
 * can tell a stale lock from a live one and recover. Studio needs this: a
 * crashed build must not brick the next start.
 *
 * @param {string} dshHome - absolute DSH home directory
 * @returns {{checked: boolean, cleared: boolean, stalePid: number|null, path: string}}
 */
export function clearStaleProfileLock(dshHome) {
  const lockPath = `${dshHome.replace(/\\/g, '/')}/profiles/node_modules.lock`
  const result = { checked: false, cleared: false, stalePid: null, path: lockPath }
  let raw
  try {
    raw = fs.readFileSync(lockPath, 'utf8')
  } catch {
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
  } catch {
    /* leave it; the launcher will surface the timeout */
  }
  return result
}
