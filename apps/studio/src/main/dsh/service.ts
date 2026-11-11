/**
 * Owns the DSH connection state and the lifecycle of the probe that may be running.
 *
 * Two rules drive this file, both learned from review:
 *
 *  1. One probe at a time. A second request joins the running one instead of stacking a
 *     second runtime process on the machine.
 *  2. The service is the shutdown coordinator. Quitting asks it to stop, and it does not
 *     report "done" until the runtime owned by the running probe has been reaped — the
 *     SDK close plus an OS-level check that nothing is still attached to this DSH home.
 */
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import type { StudioConfig } from '../config'
import type { Logger } from '../logger'
import { INITIAL_STATE, type DshConnectionState, type DshStatusDetail } from '../../shared/status'
import { resolveDshEntry } from './locate'
import { runProbe, type ProbeHandle, type TeardownReport } from './probe'

export type CheckReason = 'startup' | 'manual' | 'config-change'

/** How long shutdown waits for the runtime to be confirmed gone before giving up. */
export const SHUTDOWN_BOUND_MS = 20000

export interface ShutdownResult {
  /** The runtime is confirmed gone (or none ever existed). */
  completed: boolean
  /** True when shutdown had to give up waiting. */
  timedOut: boolean
  teardown: TeardownReport | null
  durationMs: number
}

export interface ServiceDeps {
  logger: Logger
  userDataDir: string
  readConfig: () => StudioConfig
  configRecovered: boolean
  configRecoveryNote: string | null
  now?: () => Date
  /** Test seam: substitutes the SDK client and the OS process probe. */
  probeDeps?: {
    clientFactory?: (options: Record<string, unknown>) => import('./probe').HarnessClientLike
    processProbe?: (dshHome: string) => import('./processes').RuntimeProcessFinding
  }
}

export class DshConnectionService extends EventEmitter {
  private state: DshConnectionState
  private handle: ProbeHandle | null = null
  private inflight: Promise<DshConnectionState> | null = null
  private shutdownPromise: Promise<ShutdownResult> | null = null
  private closed = false

  constructor(private readonly deps: ServiceDeps) {
    super()
    this.state = {
      ...INITIAL_STATE,
      configRecovered: deps.configRecovered,
      configRecoveryNote: deps.configRecoveryNote,
    }
  }

  getState(): DshConnectionState {
    return this.state
  }

  isChecking(): boolean {
    return this.inflight !== null
  }

  isClosed(): boolean {
    return this.closed
  }

  private setState(next: DshConnectionState): DshConnectionState {
    this.state = next
    this.emit('state', next)
    return next
  }

  /** Resolve the isolated DSH home; creating it is what makes the first probe work. */
  resolveDshHome(config: StudioConfig): string {
    const home = config.dsh.dshHome ?? path.join(this.deps.userDataDir, 'dsh-home')
    const absolute = path.resolve(home)
    fs.mkdirSync(absolute, { recursive: true })
    return absolute
  }

  /**
   * Run (or join) a probe.
   *
   * After shutdown has begun this refuses to start a new runtime: the application is on
   * its way out and a fresh probe would race the teardown it is waiting for.
   */
  async check(reason: CheckReason = 'manual'): Promise<DshConnectionState> {
    if (this.closed) {
      this.deps.logger.warn('dsh.probe.refused', { reason, why: 'service is shutting down' })
      this.setState({
        ...this.state,
        status: 'UNKNOWN',
        detail: { code: 'STOPPED', message: '正在退出，已拒绝新的检测。' },
      })
      return this.state
    }
    if (this.inflight) {
      this.deps.logger.info('dsh.probe.join', { reason })
      return this.inflight
    }

    const config = this.deps.readConfig()
    const now = this.deps.now ?? (() => new Date())
    const entry = resolveDshEntry(config.dsh.entryPath)

    this.setState({
      ...this.state,
      status: 'CHECKING',
      detail: { code: 'PROBE_RUNNING', message: '正在检测 DSH ...' },
      entryKind: entry.kind,
      entryPath: entry.displayPath,
      dshVersion: entry.version,
      configRecovered: this.deps.configRecovered,
      configRecoveryNote: this.deps.configRecoveryNote,
    })
    this.deps.logger.info('dsh.probe.start', {
      reason,
      entryKind: entry.kind,
      entryPath: entry.displayPath,
      entryProblem: entry.problem,
      profile: config.dsh.profile,
      timeoutMs: config.dsh.probeTimeoutMs,
    })

    let dshHome = ''
    try {
      dshHome = this.resolveDshHome(config)
    } catch (error) {
      return this.setState({
        ...this.state,
        status: 'FAILED',
        detail: { code: 'INTERNAL_ERROR', message: '无法创建 DSH 工作目录。', raw: (error as Error)?.message ?? null },
        lastCheckedAt: now().toISOString(),
      })
    }

    const handle = runProbe({
      deps: this.deps.probeDeps,
      dshHome,
      profile: config.dsh.profile,
      provider: config.dsh.provider,
      model: config.dsh.model,
      timeoutMs: config.dsh.probeTimeoutMs,
      cwd: path.join(this.deps.userDataDir, 'workspace'),
      entry,
    })
    this.handle = handle

    this.inflight = (async () => {
      const outcome = await handle.done
      this.deps.logger.info('dsh.probe.end', {
        reason,
        status: outcome.status,
        code: outcome.detail.code,
        durationMs: outcome.durationMs,
        serverInfo: outcome.serverInfo,
        runtimeExitCode: outcome.runtimeExitCode,
        teardown: outcome.teardown,
        raw: outcome.detail.raw ?? null,
      })
      const final: DshConnectionState = {
        ...this.state,
        status: outcome.status,
        detail: outcome.detail,
        lastCheckedAt: now().toISOString(),
        lastDurationMs: outcome.durationMs,
        serverInfo: outcome.serverInfo,
        runtimeExitCode: outcome.runtimeExitCode,
        entryKind: entry.kind,
        entryPath: entry.displayPath,
        dshVersion: entry.version,
      }
      this.inflight = null
      if (this.handle === handle) this.handle = null
      return this.setState(final)
    })()

    return this.inflight
  }

  /**
   * Stop the running probe and wait until its runtime is confirmed gone.
   *
   * Idempotent: a second quit request joins the first shutdown instead of issuing a
   * second close. The returned result is always a terminal answer — it never rejects,
   * because a quit path that throws is a quit path that hangs.
   */
  shutdown(reason = 'app-quit', boundMs = SHUTDOWN_BOUND_MS): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    const started = Date.now()

    this.shutdownPromise = (async (): Promise<ShutdownResult> => {
      const handle = this.handle
      if (!handle) {
        this.deps.logger.info('dsh.shutdown', { reason, hadProbe: false, completed: true, durationMs: Date.now() - started })
        return { completed: true, timedOut: false, teardown: null, durationMs: Date.now() - started }
      }

      this.deps.logger.warn('dsh.shutdown', { reason, hadProbe: true, stopping: true })
      handle.stop(reason)

      let timedOut = false
      let report: TeardownReport | null = null
      try {
        report = await Promise.race([
          handle.stopped(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error('shutdown bound exceeded')), boundMs).unref(),
          ),
        ])
      } catch {
        timedOut = true
        report = await Promise.race([handle.stopped(), Promise.resolve(null)]).catch(() => null)
      }

      const completed = report !== null && report.closed && report.processAbsent !== false && !timedOut
      this.deps.logger[completed ? 'info' : 'error']('dsh.shutdown.result', {
        reason,
        completed,
        timedOut,
        teardown: report,
        durationMs: Date.now() - started,
      })
      return { completed, timedOut, teardown: report, durationMs: Date.now() - started }
    })()

    return this.shutdownPromise
  }
}
