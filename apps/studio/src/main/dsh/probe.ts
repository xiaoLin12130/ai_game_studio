/**
 * The readiness probe, and the lifecycle of the runtime it owns.
 *
 * Ready means: the runtime started, completed the SDK handshake, AND the runtime this
 * probe created was confirmed gone afterwards. A handshake whose process could not be
 * reaped is not "ready" — the UI must not show a healthy state over a leaked process.
 *
 * Confirmation is three-way and only one of the three decides success:
 *
 *   close() resolved                 → the SDK says the child exited
 *   "exit code: N" observed          → diagnostic only, recorded, never a success gate
 *   OS process table says ABSENT     → the deciding evidence
 *
 * If the SDK fails or times out, the probe attempts a bounded, ownership-verified
 * termination of whatever is left, then asks the OS again. Only ABSENT counts.
 */
import path from 'node:path'
import { classifyProbeError, type DshServerInfo, type DshStatus, type DshStatusDetail } from '../../shared/status'
import type { DshEntry } from './locate'
import { createProcessTable, createRuntimeProcessTerminator, type ProcessTable, type TerminationResult } from './processes'

/** Import the ESM-only SDK from this CommonJS main process.
 *
 * TypeScript rewrites `import()` to `require()` for CommonJS output, which cannot load an
 * ESM package, so the dynamic import is built at runtime and given an absolute file URL.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

interface SdkModule {
  HarnessClient: new (options: Record<string, unknown>) => HarnessClientLike
}

export interface HarnessClientLike {
  start(): void
  initialize(params: Record<string, unknown>): Promise<{ serverInfo?: DshServerInfo }>
  close(): Promise<void>
  subscribe(): {
    next(): Promise<unknown>
    close(): void
    [Symbol.asyncIterator](): AsyncIterator<unknown>
  }
}

let cachedSdk: SdkModule | null = null

export async function loadSdk(sdkEntry: string): Promise<SdkModule> {
  if (cachedSdk) return cachedSdk
  const { pathToFileURL } = await import('node:url')
  const loaded = (await importEsm(pathToFileURL(sdkEntry).href)) as SdkModule
  if (typeof loaded?.HarnessClient !== 'function') {
    throw new Error('the loaded SDK module does not export HarnessClient')
  }
  cachedSdk = loaded
  return loaded
}

/** Where the SDK module lives, resolved once so the probe never guesses. */
export function sdkEntryPath(): string {
  return require.resolve('@deepseek-ai/dsh-sdk-client')
}

/** The child environment, with the Electron host quirk handled. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export type TeardownReason = 'completed' | 'failed' | 'timeout' | 'stopped' | 'not-started'
export type ProcessCheckStatus = 'ABSENT' | 'PRESENT' | 'FAILED' | 'SKIPPED'

/** Everything that happened to the runtime this probe owned. */
export interface TeardownReport {
  /** Did a runtime process ever exist for this probe? */
  attempted: boolean
  reason: TeardownReason
  /** The SDK's close() resolved. */
  closed: boolean
  closeError: string | null
  /** Exit code the SDK reported — diagnostic only, never a success condition. */
  exitCode: number | null
  processCheckStatus: ProcessCheckStatus
  /** true only when the OS table said ABSENT; null means "could not determine". */
  processAbsent: boolean | null
  remainingPids: number[]
  forcedTerminationAttempted: boolean
  forcedTerminationSucceeded: boolean
  error: string | null
  durationMs: number
  /** Strict: close succeeded AND the OS confirmed the process is gone. */
  completed: boolean
}

export interface ProbeRequest {
  dshHome: string
  profile: string
  provider: string
  model: string
  timeoutMs: number
  cwd: string
  entry: DshEntry
  /** Test seams only; production uses the real SDK, the real table and the real killer. */
  deps?: {
    clientFactory?: (options: Record<string, unknown>) => HarnessClientLike
    processProbe?: (dshHome: string) => import('./processes').RuntimeProcessFinding
    processTable?: ProcessTable
    terminate?: (dshHome: string, boundMs?: number) => Promise<TerminationResult>
  }
}

export interface ProbeOutcome {
  status: DshStatus
  detail: DshStatusDetail
  serverInfo: DshServerInfo | null
  runtimeExitCode: number | null
  durationMs: number
  teardown: TeardownReport
}

/** One probe, with the ability to stop it and wait for its runtime to be gone. */
export interface ProbeHandle {
  /** Settles only after teardown. */
  done: Promise<ProbeOutcome>
  /** Idempotent. Asking twice must not produce a second close. */
  stop(reason: string): void
  /** Resolves with the teardown report; never rejects. */
  stopped(): Promise<TeardownReport>
  readonly stoppedRequested: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const firstLine = (value: unknown): string | null => {
  const text = String((value as Error)?.message ?? value ?? '')
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null
}

/** Upper bound for the close. The SDK's own ladder is bounded; this is the net. */
export const TEARDOWN_BOUND_MS = 15000
/** Upper bound for the fallback termination and its verification. */
export const FORCE_TERMINATION_BOUND_MS = 6000

class ProbeStopped extends Error {
  constructor() {
    super('probe stopped by caller')
    this.name = 'ProbeStopped'
  }
}

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** Every line the SDK puts after "exit code: <n>" — the only channel it exposes. */
export function exitCodeFromMessage(message: string | null | undefined): number | null {
  const match = /(?:^|\n)exit code: (-?\d+)(?:\n|$)/.exec(String(message ?? ''))
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) ? value : null
}

export function runProbe(request: ProbeRequest): ProbeHandle {
  const started = Date.now()
  const table = request.deps?.processTable ?? createProcessTable()
  const processProbe = request.deps?.processProbe ?? table.findRuntimeProcesses
  const terminate = request.deps?.terminate ?? createRuntimeProcessTerminator({ table })

  let client: HarnessClientLike | null = null
  let subscription: ReturnType<HarnessClientLike['subscribe']> | null = null
  let subscriptionError: unknown = null
  let drain: Promise<void> = Promise.resolve()
  let stopReason: string | null = null
  let rejectStop: ((error: Error) => void) | null = null
  let teardown: Promise<TeardownReport> | null = null

  const stopSignal = new Promise<never>((_resolve, reject) => {
    rejectStop = reject
  })
  stopSignal.catch(() => {
    /* consumed by the race below */
  })

  const finish = (
    status: DshStatus,
    detail: DshStatusDetail,
    serverInfo: DshServerInfo | null,
    exitCode: number | null,
    teardownReport: TeardownReport,
  ): ProbeOutcome => ({
    status,
    detail,
    serverInfo,
    runtimeExitCode: exitCode,
    durationMs: Date.now() - started,
    teardown: teardownReport,
  })

  const beginTeardown = (reason: TeardownReason): Promise<TeardownReport> => {
    if (teardown) return teardown
    teardown = (async (): Promise<TeardownReport> => {
      const t0 = Date.now()
      const report: TeardownReport = {
        attempted: client !== null,
        reason,
        closed: false,
        closeError: null,
        exitCode: null,
        processCheckStatus: 'SKIPPED',
        processAbsent: null,
        remainingPids: [],
        forcedTerminationAttempted: false,
        forcedTerminationSucceeded: false,
        error: null,
        durationMs: 0,
        completed: false,
      }

      if (!client) {
        // Nothing was ever spawned, so nothing can be left behind.
        report.processCheckStatus = 'ABSENT'
        report.processAbsent = true
        report.completed = true
        report.durationMs = Date.now() - t0
        return report
      }

      try {
        await bounded(client.close(), TEARDOWN_BOUND_MS, 'dsh close')
        report.closed = true
      } catch (error) {
        report.closeError = firstLine(error)
        report.error = report.closeError
      }

      // The exit code arrives through the subscription rejection; it is recorded for
      // diagnostics and is deliberately not part of the success condition.
      await Promise.race([drain, sleep(3000)])
      report.exitCode = exitCodeFromMessage((subscriptionError as Error | null)?.message ?? null)

      let found = processProbe(request.dshHome)
      report.processCheckStatus = found.status
      report.processAbsent = found.status === 'ABSENT' ? true : found.status === 'PRESENT' ? false : null
      report.remainingPids = found.status === 'PRESENT' ? found.pids : []
      if (found.status === 'FAILED') {
        report.error = (report.error ? report.error + '; ' : '') + 'process check failed: ' + (found.error ?? 'unknown')
      }

      // Only when the OS says the runtime may still be there do we reach for the
      // fallback. A failed check is not a licence to kill: ownership cannot be proven.
      if (found.status === 'PRESENT') {
        const termination = await terminate(request.dshHome, FORCE_TERMINATION_BOUND_MS)
        report.forcedTerminationAttempted = termination.attempted
        report.forcedTerminationSucceeded = termination.succeeded
        if (termination.error) report.error = (report.error ? report.error + '; ' : '') + termination.error

        // Re-query: the fallback only counts if the OS agrees the process is gone.
        const after = processProbe(request.dshHome)
        report.processCheckStatus = after.status
        report.processAbsent = after.status === 'ABSENT' ? true : after.status === 'PRESENT' ? false : null
        report.remainingPids = after.status === 'PRESENT' ? after.pids : []
        if (after.status === 'FAILED') {
          report.error = (report.error ? report.error + '; ' : '') + 'process check after termination failed: ' + (after.error ?? 'unknown')
        }
      }

      report.completed = report.closed && report.processAbsent === true
      report.durationMs = Date.now() - t0
      return report
    })()
    return teardown
  }

  const done = (async (): Promise<ProbeOutcome> => {
    if (request.entry.problem) {
      const report = await beginTeardown('not-started')
      return finish('UNAVAILABLE', { code: 'BINARY_MISSING', message: '找不到可用的 DSH 运行时。', raw: request.entry.problem }, null, null, report)
    }

    try {
      const sdk = await loadSdk(sdkEntryPath())
      if (stopReason) throw new ProbeStopped()

      const options: Record<string, unknown> = {
        dshHome: request.dshHome,
        profile: request.profile,
        initializeTimeoutMs: request.timeoutMs,
        disposeGraceMs: 4000,
        // The SDK launches the runtime with `process.execPath`. Inside Electron that is
        // electron.exe, which starts a GUI app rather than a Node program and never speaks
        // JSON-RPC on stdio — the handshake then times out with no other explanation.
        env: childEnvironment(),
      }
      if (request.entry.bin) options.dshBin = request.entry.bin

      const factory = request.deps?.clientFactory ?? ((opts: Record<string, unknown>) => new sdk.HarnessClient(opts))
      client = factory(options)
      if (stopReason) throw new ProbeStopped()

      subscription = client.subscribe()
      drain = (async () => {
        try {
          for await (const _notification of subscription as AsyncIterable<unknown>) {
            /* the probe only needs the terminal rejection */
          }
        } catch (error) {
          subscriptionError = error
        }
      })()

      client.start()

      const initialize = client.initialize({ cwd: request.cwd, provider: request.provider, model: request.model })
      initialize.catch(() => {
        /* the race below owns this rejection */
      })
      const initialized = await Promise.race([initialize, stopSignal])
      const serverInfo = initialized?.serverInfo ?? null
      if (stopReason) throw new ProbeStopped()
      if (!serverInfo) {
        const report = await beginTeardown('failed')
        return finish('UNKNOWN', { code: 'INTERNAL_ERROR', message: 'DSH 已响应，但没有返回运行时标识。' }, null, report.exitCode, report)
      }

      const report = await beginTeardown('completed')
      if (!report.completed) {
        // The handshake worked, but the runtime it created is not confirmed gone. Show a
        // non-healthy state and keep the diagnostics: a green card over a leaked process
        // is exactly what this check exists to prevent.
        return finish(
          'UNKNOWN',
          {
            code: 'TEARDOWN_UNCONFIRMED',
            message: 'DSH 握手成功，但未能确认运行时已退出。',
            raw: report.error ?? report.closeError,
          },
          serverInfo,
          report.exitCode,
          report,
        )
      }
      return finish('READY', { code: 'HANDSHAKE_OK', message: 'DSH 运行时已启动并完成 SDK 握手。' }, serverInfo, report.exitCode, report)
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      const stopped = error instanceof ProbeStopped || stopReason !== null
      const report = await beginTeardown(stopped ? 'stopped' : /exceeded|timed out/i.test(message) ? 'timeout' : 'failed')
      if (stopped) {
        return finish(
          'UNKNOWN',
          { code: 'STOPPED', message: '检测被停止，运行时已回收。', raw: stopReason },
          null,
          report.exitCode,
          report,
        )
      }
      if (/exceeded|timed out/i.test(message)) {
        return finish(
          'TIMEOUT',
          { code: 'TIMEOUT', message: 'DSH 在限定时间内没有完成握手。', raw: firstLine(message) },
          null,
          report.exitCode,
          report,
        )
      }
      const classified = classifyProbeError(message)
      return finish(classified.status, classified.detail, null, report.exitCode, report)
    } finally {
      try {
        subscription?.close()
      } catch {
        /* already closed */
      }
    }
  })()

  return {
    done,
    get stoppedRequested() {
      return stopReason !== null
    },
    stop(reason: string) {
      if (stopReason !== null) return
      stopReason = reason
      void beginTeardown('stopped')
      rejectStop?.(new ProbeStopped())
    },
    stopped() {
      return beginTeardown(stopReason ? 'stopped' : 'completed')
    },
  }
}
