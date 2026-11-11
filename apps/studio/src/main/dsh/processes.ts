/**
 * OS-level view of the runtime processes a probe owns: find them, verify ownership, and —
 * when the SDK's own shutdown did not manage to reap them — terminate them safely.
 *
 * Three principles:
 *
 *   1. "Could not look" is never "nothing is running". A failed query is FAILED, and it is
 *      never treated as success by the caller.
 *   2. A process is only terminated after its command line is re-read and still names this
 *      probe's isolated DSH home. Open-ended kills ("all node.exe") are not acceptable.
 *   3. After terminating, the table is queried again; success requires the OS to say ABSENT.
 */
import { execFileSync } from 'node:child_process'

export interface RuntimeProcessFinding {
  status: 'PRESENT' | 'ABSENT' | 'FAILED'
  pids: number[]
  error: string | null
  checkedAt: string
}

export interface ProcessInspection {
  found: boolean
  pid: number | null
  name: string | null
  commandLine: string | null
  error: string | null
}

export interface TerminationResult {
  attempted: boolean
  /** PIDs we verified as ours and asked the OS to terminate. */
  killedPids: number[]
  /** PIDs skipped because ownership could not be re-verified. */
  skippedPids: number[]
  remainingPids: number[]
  /** The OS reported ABSENT after the termination round. */
  succeeded: boolean
  error: string | null
  durationMs: number
}

export interface CommandResult {
  ok: boolean
  stdout: string
  error: string | null
}

export type CommandRunner = (script: string) => CommandResult
export type ProcessKiller = (pid: number) => { ok: boolean; error: string | null }

const SENTINEL = 'studio-process-check'
const POLL_INTERVAL_MS = 250

/** Run one PowerShell CIM query, bounded so a wedged WMI service cannot hang shutdown. */
export function defaultRunner(script: string, timeoutMs = 8000): CommandResult {
  try {
    const stdout = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    )
    return { ok: true, stdout, error: null }
  } catch (error) {
    return { ok: false, stdout: '', error: String((error as Error)?.message ?? error) }
  }
}

/** Terminate one PID and its children. Only ever called with a re-verified PID. */
export const defaultKiller: ProcessKiller = (pid) => {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

const quote = (value: string): string => "'" + value.split("'").join("''") + "'"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface ProcessTable {
  findRuntimeProcesses(dshHome: string): RuntimeProcessFinding
  inspectProcess(pid: number): ProcessInspection
}

/**
 * Build a process table over one command runner.
 *
 * Matching is by "command line contains this DSH home" so it cannot be satisfied by an
 * unrelated Node process; the sentinel keeps the query from matching itself.
 */
export function createProcessTable(runner: CommandRunner = defaultRunner): ProcessTable {
  const runJson = (script: string): { ok: boolean; data: unknown; error: string | null } => {
    const run = runner(script)
    if (!run.ok) return { ok: false, data: null, error: run.error ?? 'process query failed' }
    try {
      const parsed = JSON.parse(run.stdout)
      if (!parsed?.ok) return { ok: false, data: null, error: String(parsed?.error ?? 'cim query failed') }
      return { ok: true, data: parsed.data ?? null, error: null }
    } catch {
      return { ok: false, data: null, error: 'unparsable process list' }
    }
  }

  return {
    findRuntimeProcesses(dshHome: string): RuntimeProcessFinding {
      const checkedAt = new Date().toISOString()
      if (process.platform !== 'win32') {
        return { status: 'FAILED', pids: [], error: 'unsupported platform: ' + process.platform, checkedAt }
      }
      const script = [
        '$__sentinel = ' + quote(SENTINEL) + ';',
        '$ErrorActionPreference = "Stop";',
        '$needle = ' + quote(dshHome) + ';',
        'try {',
        '  $rows = @(Get-CimInstance Win32_Process | Where-Object {',
        '    $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.CommandLine -notlike "*$__sentinel*" -and $_.Name -ne "conhost.exe"',
        '  } | Select-Object ProcessId,Name);',
        '  [pscustomobject]@{ ok = $true; data = $rows } | ConvertTo-Json -Compress -Depth 4',
        '} catch {',
        '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
        '}',
      ].join(' ')
      const result = runJson(script)
      if (!result.ok) return { status: 'FAILED', pids: [], error: result.error, checkedAt }
      const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : []
      const pids = rows
        .map((row) => Number((row as { ProcessId?: number })?.ProcessId))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
      return { status: pids.length > 0 ? 'PRESENT' : 'ABSENT', pids, error: null, checkedAt }
    },

    inspectProcess(pid: number): ProcessInspection {
      if (process.platform !== 'win32') {
        return { found: false, pid, name: null, commandLine: null, error: 'unsupported platform' }
      }
      const script = [
        '$ErrorActionPreference = "Stop";',
        'try {',
        '  $row = Get-CimInstance Win32_Process -Filter ' + quote('ProcessId = ' + pid) + ' | Select-Object ProcessId,Name,CommandLine;',
        '  [pscustomobject]@{ ok = $true; data = $row } | ConvertTo-Json -Compress -Depth 4',
        '} catch {',
        '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
        '}',
      ].join(' ')
      const result = runJson(script)
      if (!result.ok) return { found: false, pid, name: null, commandLine: null, error: result.error }
      const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
        | { Name?: string; CommandLine?: string }
        | null
      if (!row) return { found: false, pid, name: null, commandLine: null, error: null }
      return { found: true, pid, name: String(row.Name ?? ''), commandLine: String(row.CommandLine ?? ''), error: null }
    },
  }
}

/**
 * Terminate whatever is left of a probe's runtime.
 *
 * Only PIDs whose command line still contains `dshHome` are touched; anything else is
 * recorded as skipped and left alone. Success means the OS table says ABSENT afterwards.
 */
export function createRuntimeProcessTerminator(options: {
  table?: ProcessTable
  killer?: ProcessKiller
  sleepFn?: (ms: number) => Promise<void>
  now?: () => number
} = {}) {
  const table = options.table ?? createProcessTable()
  const killer = options.killer ?? defaultKiller
  const sleepFn = options.sleepFn ?? sleep
  const now = options.now ?? (() => Date.now())

  return async function terminateRuntime(
    dshHome: string,
    boundMs = 6000,
  ): Promise<TerminationResult> {
    const started = now()
    const result: TerminationResult = {
      attempted: false,
      killedPids: [],
      skippedPids: [],
      remainingPids: [],
      succeeded: false,
      error: null,
      durationMs: 0,
    }

    const before = table.findRuntimeProcesses(dshHome)
    if (before.status === 'ABSENT') {
      result.succeeded = true
      result.durationMs = now() - started
      return result
    }
    if (before.status === 'FAILED') {
      result.error = 'process check failed before termination: ' + (before.error ?? 'unknown')
      result.durationMs = now() - started
      return result
    }

    result.attempted = true
    for (const pid of before.pids) {
      // Re-read the process immediately before killing it: PID reuse is real, and the
      // ownership evidence has to be current, not a few seconds old.
      const inspected = table.inspectProcess(pid)
      if (!inspected.found || !String(inspected.commandLine ?? '').includes(dshHome)) {
        result.skippedPids.push(pid)
        continue
      }
      const kill = killer(pid)
      if (kill.ok) result.killedPids.push(pid)
      else result.error = (result.error ? result.error + '; ' : '') + 'taskkill ' + pid + ': ' + (kill.error ?? 'failed')
    }

    // Poll until the table is clean or the bound expires.
    let after = table.findRuntimeProcesses(dshHome)
    while (after.status === 'PRESENT' && now() - started < boundMs) {
      await sleepFn(POLL_INTERVAL_MS)
      after = table.findRuntimeProcesses(dshHome)
    }

    result.remainingPids = after.status === 'PRESENT' ? after.pids : []
    result.succeeded = after.status === 'ABSENT'
    if (after.status === 'FAILED') {
      result.error = (result.error ? result.error + '; ' : '') + 'process check failed after termination: ' + (after.error ?? 'unknown')
    }
    result.durationMs = now() - started
    return result
  }
}

export const findRuntimeProcesses = createProcessTable().findRuntimeProcesses
