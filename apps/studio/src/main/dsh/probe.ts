/**
 * The readiness probe, and the lifecycle of the runtime it owns.
 *
 * Ready means: the runtime started, completed the SDK handshake, AND the runtime this
 * probe created was confirmed gone afterwards. A handshake whose process could not be
 * reaped is not "ready" — the UI must not show a healthy state over a leaked process.
 *
 * Ownership is an instance identity, not a directory: the SDK passes the DSH home as an
 * environment variable, so a live runtime's command line does not contain it at all
 * (measured — a home-based matcher finds zero running runtimes). What the OS does record
 * is the link the SDK created: the child of *this* process running the dsh CLI. That pair
 * is captured while the probe is live and pinned with the process creation time, so two
 * instances sharing a home never see each other's runtime and a recycled PID is refused.
 *
 * The deciding evidence for "gone" is the operating system, and every operation runs
 * against one absolute deadline: close, identity capture, the fallback termination and
 * its final confirmation all draw from the same budget. The SDK's exit code is recorded
 * as a diagnostic and is never a success condition.
 */
import path from 'node:path'
import { classifyProbeError, type DshServerInfo, type DshStatus, type DshStatusDetail } from '../../shared/status'
import type { DshEntry } from './locate'
import { withCredential } from './credentials'
import {
  captureRuntimeIdentity,
  defaultKiller,
  defaultProcessTable,
  terminateRuntimeIdentity,
  type AsyncProcessKiller,
  type CaptureResult,
  type ProcessTable,
  type RuntimeIdentity,
  type TerminationResult,
} from './processes'

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
  /** Session-level API, present on the real client and used by the task runner. */
  prompt?(sessionId: string, contentBlocks: unknown[]): Promise<string>
  resumeSession?(sessionId: string): Promise<void>
  subscribeSessionTree?(sessionId: string): unknown
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

/** The substring that identifies the dsh CLI in a command line. */
export function binMarkerFor(entry: DshEntry): string {
  if (entry.kind === 'bundled') return path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return entry.bin ?? ''
}

export type TeardownReason = 'completed' | 'failed' | 'timeout' | 'stopped' | 'not-started'
export type ProcessCheckStatus = 'ABSENT' | 'PRESENT' | 'FAILED' | 'SKIPPED'

/** Everything that happened to the runtime this probe owned. */
export interface TeardownReport {
  attempted: boolean
  reason: TeardownReason
  /** The SDK's close() resolved. */
  closed: boolean
  closeError: string | null
  /** Exit code the SDK reported — diagnostic only, never a success condition. */
  exitCode: number | null
  processCheckStatus: ProcessCheckStatus
  /** The first OS check, before any fallback ran. "Clean" means close alone sufficed. */
  firstCheckStatus: ProcessCheckStatus
  /** true only when the OS said the runtime is gone; null means "could not determine". */
  processAbsent: boolean | null
  runtimePid: number | null
  identitySource: RuntimeIdentity['source'] | null
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
    processTable?: ProcessTable
    killer?: AsyncProcessKiller
    captureIdentity?: typeof captureRuntimeIdentity
    terminateIdentity?: typeof terminateRuntimeIdentity
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
  done: Promise<ProbeOutcome>
  stop(reason: string): void
  stopped(): Promise<TeardownReport>
  readonly stoppedRequested: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, ms)))
const firstLine = (value: unknown): string | null => {
  const text = String((value as Error)?.message ?? value ?? '')
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null
}

/** Upper bound for the whole teardown: close + fallback + final confirmation. */
export const TEARDOWN_BOUND_MS = 22000
/** Upper bound for the close alone. */
export const CLOSE_BOUND_MS = 15000
/** Upper bound for the fallback termination and its verification. */
export const FORCE_TERMINATION_BOUND_MS = 6000
/** How long to wait for the OS to show us the child we just spawned. */
export const IDENTITY_CAPTURE_BOUND_MS = 8000

class ProbeStopped extends Error {
  constructor() {
    super('probe stopped by caller')
    this.name = 'ProbeStopped'
  }
}

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' exceeded ' + ms + 'ms')), Math.max(1, ms))
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
  const table = request.deps?.processTable ?? defaultProcessTable
  const killer = request.deps?.killer ?? defaultKiller
  const captureIdentity = request.deps?.captureIdentity ?? captureRuntimeIdentity
  const terminateIdentity = request.deps?.terminateIdentity ?? terminateRuntimeIdentity
  const marker = binMarkerFor(request.entry)

  let client: HarnessClientLike | null = null
  let subscription: ReturnType<HarnessClientLike['subscribe']> | null = null
  let subscriptionError: unknown = null
  let drain: Promise<void> = Promise.resolve()
  let stopReason: string | null = null
  let rejectStop: ((error: Error) => void) | null = null
  let teardown: Promise<TeardownReport> | null = null
  let capturePromise: Promise<CaptureResult> | null = null
  let identity: RuntimeIdentity | null = null

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
      const deadline = t0 + TEARDOWN_BOUND_MS
      const budget = () => Math.max(0, deadline - Date.now())
      const report: TeardownReport = {
        attempted: client !== null,
        reason,
        closed: false,
        closeError: null,
        exitCode: null,
        processCheckStatus: 'SKIPPED',
        firstCheckStatus: 'SKIPPED',
        processAbsent: null,
        runtimePid: null,
        identitySource: null,
        remainingPids: [],
        forcedTerminationAttempted: false,
        forcedTerminationSucceeded: false,
        error: null,
        durationMs: 0,
        completed: false,
      }

      if (!client) {
        report.processCheckStatus = 'ABSENT'
        report.processAbsent = true
        report.completed = true
        report.durationMs = Date.now() - t0
        return report
      }

      // ---- close, inside the shared budget ----
      const closeBudget = Math.min(CLOSE_BOUND_MS, budget())
      if (closeBudget <= 0) {
        report.closeError = 'no time left for the SDK close'
        report.error = report.closeError
      } else {
        try {
          await bounded(client.close(), closeBudget, 'dsh close')
          report.closed = true
        } catch (error) {
          report.closeError = firstLine(error)
          report.error = report.closeError
        }
      }

      // The exit code arrives through the subscription rejection; recorded for diagnostics
      // only — it comes from the same side as close() and proves nothing on its own.
      await Promise.race([drain, sleep(Math.min(3000, budget()))])
      report.exitCode = exitCodeFromMessage((subscriptionError as Error | null)?.message ?? null)

      // ---- pin the identity the OS recorded for the child we spawned ----
      if (capturePromise) {
        const captureBudget = Math.min(IDENTITY_CAPTURE_BOUND_MS, budget())
        const settled = await Promise.race([
          capturePromise,
          sleep(Math.max(1, captureBudget)).then(() => null),
        ]).catch(() => null)
        if (settled) {
          identity = settled.identity
          report.runtimePid = settled.identity?.pid ?? null
          report.identitySource = settled.identity?.source ?? null
          if (settled.status === 'failed') {
            report.error = (report.error ? report.error + '; ' : '') + 'identity capture failed: ' + (settled.error ?? 'unknown')
          }
          if (settled.status === 'absent' && !report.closed) {
            report.error = (report.error ? report.error + '; ' : '') + 'runtime never appeared in the process table and close did not succeed'
          }
        } else {
          report.error = (report.error ? report.error + '; ' : '') + 'identity capture did not finish inside the budget'
        }
      }

      /** Ask the OS whether the pinned runtime is still there. */
      const inspectRuntime = async (): Promise<void> => {
        if (!identity) {
          // We never established which process was ours, so its exit cannot be confirmed —
          // not even by a successful close. Unknown is not success.
          report.processCheckStatus = 'FAILED'
          report.processAbsent = null
          report.error = (report.error ? report.error + '; ' : '') + 'runtime identity was never established'
          return
        }
        const inspectBudget = Math.min(4000, budget())
        if (inspectBudget <= 0) {
          report.processCheckStatus = 'FAILED'
          report.processAbsent = null
          report.error = (report.error ? report.error + '; ' : '') + 'no time left to confirm the runtime is gone'
          return
        }
        const inspection = await table.inspect(identity.pid, inspectBudget)
        if (inspection.error) {
          report.processCheckStatus = 'FAILED'
          report.processAbsent = null
          report.error = (report.error ? report.error + '; ' : '') + 'process check failed: ' + inspection.error
          return
        }
        if (!inspection.found) {
          report.processCheckStatus = 'ABSENT'
          report.processAbsent = true
          report.remainingPids = []
          return
        }
        if (identity.creationMs !== null && inspection.process?.creationMs !== null && inspection.process?.creationMs !== identity.creationMs) {
          // The PID now belongs to somebody else: our runtime is gone.
          report.processCheckStatus = 'ABSENT'
          report.processAbsent = true
          report.remainingPids = []
          return
        }
        report.processCheckStatus = 'PRESENT'
        report.processAbsent = false
        report.remainingPids = [identity.pid]
      }

      await inspectRuntime()
      report.firstCheckStatus = report.processCheckStatus

      // ---- fallback: only for a runtime we proved is ours, and only within budget ----
      if (report.processCheckStatus === 'PRESENT' && identity) {
        const forceBudget = Math.min(FORCE_TERMINATION_BOUND_MS, budget())
        if (forceBudget <= 0) {
          report.error = (report.error ? report.error + '; ' : '') + 'no time left for the fallback termination'
        } else {
          const termination = await terminateIdentity(table, killer, identity, { deadline: Date.now() + forceBudget })
          report.forcedTerminationAttempted = termination.attempted
          report.forcedTerminationSucceeded = termination.succeeded
          if (termination.error) report.error = (report.error ? report.error + '; ' : '') + termination.error
          if (termination.remainingPids.length > 0) report.remainingPids = termination.remainingPids
          // The final confirmation is mandatory: a deadline is not "gone".
          await inspectRuntime()
        }
      }

      // "completed" is the clean path: close alone was enough, and the OS agreed.
      // A runtime that needed the fallback is confirmed gone, but it was not a clean exit.
      report.completed =
        report.closed && report.processAbsent === true && report.firstCheckStatus === 'ABSENT'
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
        env: withCredential(childEnvironment(), 'COMMANDCODE_API_KEY', request.dshHome).env,
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
      // Capture while the handshake runs: the child is the one process whose parent is us
      // and whose command line runs the dsh CLI. This is the ownership evidence.
      capturePromise = captureIdentity(table, {
        parentPid: process.pid,
        binMarker: marker,
        deadline: Date.now() + IDENTITY_CAPTURE_BOUND_MS,
      })

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
