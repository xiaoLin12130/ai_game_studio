/**
 * OS-level view of the runtime a probe owns: find it, prove it is ours, and — only when
 * the SDK's own shutdown did not reap it — terminate it inside a real deadline.
 *
 * Why identity is not "the command line contains our DSH home":
 * measurement on this machine shows the SDK passes the home as an environment variable,
 * so a live runtime's command line does not contain it at all. A home-based matcher
 * reports ABSENT while the runtime is running — and would happily report a clean shutdown
 * it never checked. Worse, two instances can share one home.
 *
 * What actually identifies our runtime is the relationship the OS recorded when the SDK
 * spawned it: the child of *this* process whose command line runs the dsh CLI. That pair
 * is captured while the probe is live, and pinned with the process creation time so a
 * recycled PID is never mistaken for ours. The home is not used as an authorization at
 * all.
 *
 * Every operation takes an absolute deadline. Each PowerShell call is asynchronous and
 * gets a timeout no larger than the budget that is left, so a slow query cannot blow
 * through the bound, and it cannot block the Electron main process either.
 */
import { execFile } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  /** Creation time in epoch milliseconds when the OS exposes it. */
  creationMs: number | null
  commandLine: string
}

export interface ListResult {
  ok: boolean
  processes: ProcessInfo[]
  error: string | null
  durationMs: number
}

export interface InspectResult {
  found: boolean
  process: ProcessInfo | null
  error: string | null
  durationMs: number
}

export interface ProcessTable {
  list(boundMs: number): Promise<ListResult>
  /** Children of one PID — much cheaper than listing the whole table. */
  listChildren(parentPid: number, boundMs: number): Promise<ListResult>
  inspect(pid: number, boundMs: number): Promise<InspectResult>
}

export interface RuntimeIdentity {
  pid: number
  /** Pinned at capture; a different value at kill time means the PID was recycled. */
  creationMs: number | null
  capturedAt: string
  /** How the identity was established, for the evidence trail. */
  source: 'parent-and-bin' | 'injected'
}

export interface CaptureResult {
  status: 'captured' | 'absent' | 'failed'
  identity: RuntimeIdentity | null
  error: string | null
  candidates: number
  durationMs: number
}

export interface TerminationResult {
  attempted: boolean
  killedPids: number[]
  skippedPids: number[]
  remainingPids: number[]
  succeeded: boolean
  error: string | null
  durationMs: number
  /** True when the deadline ran out before a final confirmation could be made. */
  deadlineHit: boolean
}

export type AsyncCommandRunner = (script: string, timeoutMs: number) => Promise<{ ok: boolean; stdout: string; error: string | null }>
export type AsyncProcessKiller = (pid: number, timeoutMs: number) => Promise<{ ok: boolean; error: string | null }>

const SENTINEL = 'studio-process-check'
/**
 * PowerShell + WMI costs about a second before it can answer. Starting a query with less
 * budget than that guarantees a timeout and, worse, turns a bounded shutdown into a
 * stream of spurious errors. Below this floor we report "no time left" instead.
 */
export const MIN_QUERY_MS = 1200
const CAPTURE_POLL_MS = 100
const TERMINATE_POLL_MS = 150

const now = () => Date.now()
const remainingOf = (deadline: number) => Math.max(0, deadline - now())
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, ms)))

/** Run one PowerShell CIM query without blocking the event loop. */
export const defaultRunner: AsyncCommandRunner = (script, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    const done = (result: { ok: boolean; stdout: string; error: string | null }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: Math.max(50, timeoutMs), maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          if (error) done({ ok: false, stdout: '', error: String((error as Error)?.message ?? error) })
          else done({ ok: true, stdout: String(stdout ?? ''), error: null })
        },
      )
      child.on('error', (error) => done({ ok: false, stdout: '', error: String(error?.message ?? error) }))
    } catch (error) {
      done({ ok: false, stdout: '', error: String((error as Error)?.message ?? error) })
    }
  })

/** Terminate one verified PID and its children, bounded. */
export const defaultKiller: AsyncProcessKiller = (pid, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    const done = (result: { ok: boolean; error: string | null }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = execFile(
        'taskkill',
        ['/F', '/T', '/PID', String(pid)],
        { encoding: 'utf8', windowsHide: true, timeout: Math.max(50, timeoutMs) },
        (error) => {
          if (error) done({ ok: false, error: String((error as Error)?.message ?? error) })
          else done({ ok: true, error: null })
        },
      )
      child.on('error', (error) => done({ ok: false, error: String(error?.message ?? error) }))
    } catch (error) {
      done({ ok: false, error: String((error as Error)?.message ?? error) })
    }
  })

const quote = (value: string): string => "'" + value.split("'").join("''") + "'"

/** PowerShell returns `/Date(ms)/`; accept ISO as well so the parser is not brittle. */
export function parseCreationDate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const dotNet = /\/Date\((-?\d+)\)\//.exec(value)
  if (dotNet) {
    const ms = Number.parseInt(dotNet[1], 10)
    return Number.isSafeInteger(ms) ? ms : null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * PowerShell returns `{"ok":true,"data":{}}` for a PID it cannot find — an empty object,
 * which is truthy in JavaScript. Treating that as a live process would make every
 * "is it gone?" answer a false PRESENT, so a row without a numeric ProcessId is not a row.
 */
function isProcessRow(row: unknown): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const pid = Number((row as Record<string, unknown>).ProcessId)
  return Number.isFinite(pid) && pid > 0
}

function toInfo(row: Record<string, unknown>): ProcessInfo {
  return {
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    name: String(row.Name ?? ''),
    creationMs: parseCreationDate(row.CreationDate),
    commandLine: String(row.CommandLine ?? ''),
  }
}

export interface ProcessTableOptions {
  runner?: AsyncCommandRunner
  platform?: NodeJS.Platform
}

export function createProcessTable(options: ProcessTableOptions = {}): ProcessTable {
  const runner = options.runner ?? defaultRunner
  const platform = options.platform ?? process.platform

  const describe = (pid: number) =>
    [
      '$ErrorActionPreference = "Stop";',
      'try {',
      '  $row = Get-CimInstance Win32_Process -Filter ' + quote('ProcessId = ' + pid) + ' | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine;',
      '  [pscustomobject]@{ ok = $true; data = $row } | ConvertTo-Json -Compress -Depth 4',
      '} catch {',
      '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
      '}',
    ].join(' ')

  return {
    async list(boundMs: number): Promise<ListResult> {
      const started = now()
      if (platform !== 'win32') {
        return { ok: false, processes: [], error: 'unsupported platform: ' + platform, durationMs: now() - started }
      }
      if (boundMs < MIN_QUERY_MS) {
        return { ok: false, processes: [], error: 'no time left for a process query', durationMs: 0 }
      }
      const script = [
        '$__sentinel = ' + quote(SENTINEL) + ';',
        '$ErrorActionPreference = "Stop";',
        'try {',
        '  $rows = @(Get-CimInstance Win32_Process | Where-Object {',
        '    $_.CommandLine -and $_.CommandLine -notlike "*$__sentinel*" -and $_.Name -ne "conhost.exe"',
        '  } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine);',
        '  [pscustomobject]@{ ok = $true; data = $rows } | ConvertTo-Json -Compress -Depth 4',
        '} catch {',
        '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
        '}',
      ].join(' ')
      const run = await runner(script, boundMs)
      if (!run.ok) return { ok: false, processes: [], error: run.error ?? 'process query failed', durationMs: now() - started }
      let parsed: { ok?: boolean; data?: unknown; error?: string }
      try {
        parsed = JSON.parse(run.stdout)
      } catch {
        return { ok: false, processes: [], error: 'unparsable process list', durationMs: now() - started }
      }
      if (!parsed?.ok) {
        return { ok: false, processes: [], error: parsed?.error ?? 'cim query failed', durationMs: now() - started }
      }
      const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data ? [parsed.data] : []
      return {
        ok: true,
        processes: rows.filter(isProcessRow).map((row) => toInfo(row as Record<string, unknown>)),
        error: null,
        durationMs: now() - started,
      }
    },

    async listChildren(parentPid: number, boundMs: number): Promise<ListResult> {
      const started = now()
      if (platform !== 'win32') {
        return { ok: false, processes: [], error: 'unsupported platform: ' + platform, durationMs: now() - started }
      }
      if (boundMs < MIN_QUERY_MS) {
        return { ok: false, processes: [], error: 'no time left for a process query', durationMs: 0 }
      }
      const script = [
        '$__sentinel = ' + quote(SENTINEL) + ';',
        '$ErrorActionPreference = "Stop";',
        'try {',
        '  $rows = @(Get-CimInstance Win32_Process -Filter ' + quote('ParentProcessId = ' + parentPid) + ' | Where-Object {',
        '    $_.CommandLine -and $_.CommandLine -notlike "*$__sentinel*" -and $_.Name -ne "conhost.exe"',
        '  } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine);',
        '  [pscustomobject]@{ ok = $true; data = $rows } | ConvertTo-Json -Compress -Depth 4',
        '} catch {',
        '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
        '}',
      ].join(' ')
      const run = await runner(script, boundMs)
      if (!run.ok) return { ok: false, processes: [], error: run.error ?? 'process query failed', durationMs: now() - started }
      let parsed: { ok?: boolean; data?: unknown; error?: string }
      try {
        parsed = JSON.parse(run.stdout)
      } catch {
        return { ok: false, processes: [], error: 'unparsable process list', durationMs: now() - started }
      }
      if (!parsed?.ok) return { ok: false, processes: [], error: parsed?.error ?? 'cim query failed', durationMs: now() - started }
      const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data ? [parsed.data] : []
      return {
        ok: true,
        processes: rows.filter(isProcessRow).map((row) => toInfo(row as Record<string, unknown>)),
        error: null,
        durationMs: now() - started,
      }
    },

    async inspect(pid: number, boundMs: number): Promise<InspectResult> {
      const started = now()
      if (platform !== 'win32') {
        return { found: false, process: null, error: 'unsupported platform: ' + platform, durationMs: now() - started }
      }
      if (boundMs < MIN_QUERY_MS) {
        return { found: false, process: null, error: 'no time left for a process query', durationMs: 0 }
      }
      const run = await runner(describe(pid), boundMs)
      if (!run.ok) return { found: false, process: null, error: run.error ?? 'process query failed', durationMs: now() - started }
      let parsed: { ok?: boolean; data?: unknown; error?: string }
      try {
        parsed = JSON.parse(run.stdout)
      } catch {
        return { found: false, process: null, error: 'unparsable process record', durationMs: now() - started }
      }
      if (!parsed?.ok) return { found: false, process: null, error: parsed?.error ?? 'cim query failed', durationMs: now() - started }
      const row = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data
      if (!isProcessRow(row)) return { found: false, process: null, error: null, durationMs: now() - started }
      return { found: true, process: toInfo(row as Record<string, unknown>), error: null, durationMs: now() - started }
    },
  }
}

export const defaultProcessTable = createProcessTable()

/**
 * Capture the identity of the runtime this probe just spawned.
 *
 * The evidence is the link the OS recorded: a child of *this* process whose command line
 * runs the dsh CLI. Two instances sharing a DSH home therefore never see each other's
 * runtime. The creation time is pinned so a later PID reuse cannot be mistaken for ours.
 */
export async function captureRuntimeIdentity(
  table: ProcessTable,
  options: { parentPid: number; binMarker: string; deadline: number; pollMs?: number },
): Promise<CaptureResult> {
  const started = now()
  const pollMs = options.pollMs ?? CAPTURE_POLL_MS
  let lastError: string | null = null
  let candidates = 0
  let successfulListings = 0

  while (remainingOf(options.deadline) >= MIN_QUERY_MS) {
    const listing = await table.listChildren(options.parentPid, Math.min(4000, remainingOf(options.deadline)))
    if (!listing.ok) {
      lastError = listing.error
    } else {
      successfulListings += 1
      const matches = listing.processes.filter(
        (proc) => proc.parentPid === options.parentPid && proc.commandLine.includes(options.binMarker),
      )
      candidates = matches.length
      if (matches.length === 1) {
        const match = matches[0]
        return {
          status: 'captured',
          identity: { pid: match.pid, creationMs: match.creationMs, capturedAt: new Date().toISOString(), source: 'parent-and-bin' },
          error: null,
          candidates: 1,
          durationMs: now() - started,
        }
      }
      if (matches.length > 1) {
        // More than one child matching: we cannot tell which one is ours, and guessing
        // means possibly killing the wrong one. Refuse to claim an identity.
        return {
          status: 'failed',
          identity: null,
          error: 'ambiguous runtime identity: ' + matches.length + ' matching children',
          candidates: matches.length,
          durationMs: now() - started,
        }
      }
    }
    if (remainingOf(options.deadline) <= pollMs) break
    await sleep(Math.min(pollMs, remainingOf(options.deadline)))
  }

  // "Looked and found nothing" is ABSENT; "never managed to look" is FAILED. They are not
  // the same answer and must not be merged.
  return {
    status: successfulListings > 0 ? 'absent' : 'failed',
    identity: null,
    error: lastError,
    candidates,
    durationMs: now() - started,
  }
}

/**
 * Terminate one captured identity inside an absolute deadline.
 *
 * Re-reads the process before killing it: a PID whose creation time changed is somebody
 * else's process now, and is skipped rather than killed.
 */
export async function terminateRuntimeIdentity(
  table: ProcessTable,
  killer: AsyncProcessKiller,
  identity: RuntimeIdentity,
  options: { deadline: number },
): Promise<TerminationResult> {
  const started = now()
  const result: TerminationResult = {
    attempted: false,
    killedPids: [],
    skippedPids: [],
    remainingPids: [identity.pid],
    succeeded: false,
    error: null,
    durationMs: 0,
    deadlineHit: false,
  }

  const budget = () => remainingOf(options.deadline)
  if (budget() <= 0) {
    result.deadlineHit = true
    result.error = 'deadline exceeded before termination could start'
    result.durationMs = now() - started
    return result
  }

  const first = await table.inspect(identity.pid, Math.min(4000, budget()))
  if (!first.found) {
    if (first.error) {
      const outOfTime = /no time left/i.test(first.error)
      result.error = outOfTime
        ? 'deadline reached before the runtime could be verified: ' + first.error
        : 'could not verify the runtime: ' + first.error
      if (outOfTime) result.deadlineHit = true
      result.durationMs = now() - started
      return result
    }
    result.succeeded = true
    result.remainingPids = []
    result.durationMs = now() - started
    return result
  }
  if (identity.creationMs !== null && first.process?.creationMs !== null && first.process?.creationMs !== identity.creationMs) {
    // The PID now belongs to a different process: our runtime is gone.
    result.skippedPids.push(identity.pid)
    result.remainingPids = []
    result.succeeded = true
    result.error = 'pid ' + identity.pid + ' was recycled; ownership no longer matches, nothing to kill'
    result.durationMs = now() - started
    return result
  }

  result.attempted = true
  const killBudget = Math.min(5000, budget())
  if (killBudget <= 0) {
    result.deadlineHit = true
    result.error = 'deadline exceeded before taskkill'
    result.durationMs = now() - started
    return result
  }
  const kill = await killer(identity.pid, killBudget)
  if (kill.ok) result.killedPids.push(identity.pid)
  else result.error = 'taskkill ' + identity.pid + ': ' + (kill.error ?? 'failed')

  // The final confirmation is mandatory: without it a timeout would read as success.
  while (budget() > 0) {
    await sleep(Math.min(TERMINATE_POLL_MS, budget()))
    if (budget() <= 0) break
    const check = await table.inspect(identity.pid, Math.min(3000, budget()))
    if (check.error) {
      result.error = (result.error ? result.error + '; ' : '') + 'post-termination check failed: ' + check.error
      continue
    }
    if (!check.found) {
      result.succeeded = true
      result.remainingPids = []
      result.durationMs = now() - started
      return result
    }
  }

  result.deadlineHit = true
  result.error = (result.error ? result.error + '; ' : '') + 'deadline reached before the process was confirmed gone'
  result.durationMs = now() - started
  return result
}
