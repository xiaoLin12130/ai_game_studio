/**
 * OS-level check that no runtime process for a given DSH home is still alive.
 *
 * The SDK promises that `close()` resolves "only after the process has actually exited",
 * and it reports the exit code in the documented `TransportClosedError` message. That is
 * two signals from the same side of the fence. This module adds a third, from the other
 * side: ask the operating system.
 *
 * It is deliberately narrow — it matches the runtime's own command line against the
 * isolated DSH home — so it cannot be satisfied by an unrelated Node process.
 */
import { execFileSync } from 'node:child_process'

export interface RuntimeProcessFinding {
  status: 'PRESENT' | 'ABSENT' | 'FAILED'
  pids: number[]
  error: string | null
  checkedAt: string
}

export interface CommandResult {
  ok: boolean
  stdout: string
  error: string | null
}

export type CommandRunner = (script: string) => CommandResult

/** The check excludes itself: the enumerating process must not look like a leftover. */
const SENTINEL = 'studio-process-check'

/**
 * Run one PowerShell CIM query. `execFileSync` is bounded so a wedged WMI service cannot
 * hang application shutdown.
 */
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

const quote = (value: string): string => "'" + value.split("'").join("''") + "'"

/**
 * Build the matcher for one DSH home.
 *
 * A missing result is reported as ABSENT only when the query itself succeeded; a failed
 * query is FAILED, never "absent", because "could not look" is not "nothing is running".
 */
export function createRuntimeProcessProbe(runner: (script: string) => CommandResult = defaultRunner) {
  return function findRuntimeProcesses(dshHome: string): RuntimeProcessFinding {
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

    const run = runner(script)
    if (!run.ok) return { status: 'FAILED', pids: [], error: run.error ?? 'process query failed', checkedAt }

    let parsed: { ok?: boolean; data?: unknown; error?: string }
    try {
      parsed = JSON.parse(run.stdout)
    } catch {
      return { status: 'FAILED', pids: [], error: 'unparsable process list', checkedAt }
    }
    if (!parsed?.ok) return { status: 'FAILED', pids: [], error: parsed?.error ?? 'cim query failed', checkedAt }

    const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data ? [parsed.data] : []
    const pids = rows
      .map((row) => Number((row as { ProcessId?: number })?.ProcessId))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return { status: pids.length > 0 ? 'PRESENT' : 'ABSENT', pids, error: null, checkedAt }
  }
}

export const findRuntimeProcesses = createRuntimeProcessProbe()
