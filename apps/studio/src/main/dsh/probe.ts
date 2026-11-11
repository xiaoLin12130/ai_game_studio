/**
 * The readiness probe, and the lifecycle of the runtime it owns.
 *
 * Ready means: the runtime process started, completed the SDK's `initialize` handshake
 * and answered with a server identity, then shut down. That is deliberately more than
 * "the binary exists" and less than "the model works":
 *
 *   proves      the runtime boots with this profile and home, loads its plugins, speaks
 *               the SDK protocol and reports its identity;
 *   does not    prove the provider route is reachable or funded — that needs a prompt,
 *               which costs model quota and is out of scope for a status probe.
 *
 * No prompt is ever sent here.
 *
 * Lifetime rule introduced after review: a probe is the *only* owner of the runtime it
 * spawned, and it stays responsible for that runtime until an exit is confirmed — even
 * when the user quits while `initialize` is still in flight. `close()` is never treated
 * as optional cleanup that happens "if the promise settles".
 */
import path from 'node:path'
import { classifyProbeError, type DshServerInfo, type DshStatus, type DshStatusDetail } from '../../shared/status'
import type { DshEntry } from './locate'
import { createRuntimeProcessProbe, type RuntimeProcessFinding } from './processes'

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

/** What actually happened to the runtime this probe owned. */
export interface TeardownReport {
  /** Did a runtime process ever exist for this probe? */
  attempted: boolean
  reason: TeardownReason
  /** The SDK's close() resolved — it documents that as "the process has exited". */
  closed: boolean
  /** Exit code the SDK reported for the runtime, when it reported one. */
  exitCode: number | null
  /** Independent OS-level answer: is any process still attached to this DSH home? */
  processAbsent: boolean | null
  error: string | null
  durationMs: number
}

export interface ProbeRequest {
  dshHome: string
  profile: string
  provider: string
  model: string
  timeoutMs: number
  cwd: string
  entry: DshEntry
  /** Test seams only; production always uses the real SDK and the OS probe. */
  deps?: {
    clientFactory?: (options: Record<string, unknown>) => HarnessClientLike
    processProbe?: (dshHome: string) => RuntimeProcessFinding
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
  /** Settles only after the runtime is torn down. */
  done: Promise<ProbeOutcome>
  /** Idempotent. Asking twice must not produce a second close. */
  stop(reason: string): void
  /** Resolves with the teardown report; never rejects. */
  stopped(): Promise<TeardownReport>
  /** True once stop() was called. */
  readonly stoppedRequested: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const firstLine = (value: unknown): string | null => {
  const text = String((value as Error)?.message ?? value ?? '')
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null
}

/** Upper bound for the whole teardown. The SDK's own ladder is bounded; this is the net. */
export const TEARDOWN_BOUND_MS = 15000

/** Explicit stop, as opposed to a failure that happens to end the promise. */
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

/**
 * Start a probe and return its handle immediately.
 *
 * The handle's `done` settles only after teardown, so a caller that awaits it never sees
 * a "finished" probe whose runtime is still alive.
 */
export function runProbe(request: ProbeRequest): ProbeHandle {
  const started = Date.now()
  const processProbe = request.deps?.processProbe ?? createRuntimeProcessProbe()

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
    /* the race below consumes the rejection */
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
        exitCode: null,
        processAbsent: null,
        error: null,
        durationMs: 0,
      }
      if (!client) {
        // Nothing was spawned, so nothing can be left behind.
        report.processAbsent = true
        report.closed = true
        report.durationMs = Date.now() - t0
        return report
      }
      try {
        await bounded(client.close(), TEARDOWN_BOUND_MS, 'dsh close')
        report.closed = true
      } catch (error) {
        report.error = firstLine(error)
      }
      // The exit code arrives through the subscription rejection triggered by the child's
      // exit event; wait for it briefly so the report can carry it.
      await Promise.race([drain, sleep(3000)])
      report.exitCode = exitCodeFromMessage((subscriptionError as Error | null)?.message ?? null)

      try {
        const found = processProbe(request.dshHome)
        report.processAbsent = found.status === 'ABSENT' ? true : found.status === 'PRESENT' ? false : null
        if (found.status === 'FAILED') {
          report.error = (report.error ? report.error + '; ' : '') + 'process check failed: ' + (found.error ?? 'unknown')
        }
      } catch (error) {
        report.processAbsent = null
        report.error = (report.error ? report.error + '; ' : '') + 'process check threw: ' + firstLine(error)
      }
      report.durationMs = Date.now() - t0
      return report
    })()
    return teardown
  }

  const done = (async (): Promise<ProbeOutcome> => {
    // Nothing to spawn: the entry is already known to be unusable.
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

      // A stop can arrive at any await. Racing the handshake against the stop signal is
      // what keeps "quit during initialize" from waiting out the whole timeout.
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
      // Start reaping immediately; the awaiting flow will settle on the same teardown.
      void beginTeardown('stopped')
      rejectStop?.(new ProbeStopped())
    },
    stopped() {
      return beginTeardown(stopReason ? 'stopped' : 'completed')
    },
  }
}
