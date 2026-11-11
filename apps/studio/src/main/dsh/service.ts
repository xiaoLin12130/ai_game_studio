/**
 * Owns the DSH connection state and the single probe that is allowed to run at a time.
 *
 * Rules that the UI depends on:
 *  - a manual re-check while a probe is running joins it instead of stacking another
 *    runtime process on top (the task list explicitly forbids unbounded concurrency);
 *  - every probe is cancellable, so quitting the app does not leave a runtime behind;
 *  - the state is pushed to subscribers on every transition, not polled.
 */
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import type { StudioConfig } from '../config'
import type { Logger } from '../logger'
import { INITIAL_STATE, type DshConnectionState } from '../../shared/status'
import { resolveDshEntry } from './locate'
import { runProbe } from './probe'

export type CheckReason = 'startup' | 'manual' | 'config-change'

export interface ServiceDeps {
  logger: Logger
  userDataDir: string
  readConfig: () => StudioConfig
  configRecovered: boolean
  configRecoveryNote: string | null
  now?: () => Date
}

export class DshConnectionService extends EventEmitter {
  private state: DshConnectionState
  private inflight: Promise<DshConnectionState> | null = null
  private controller: AbortController | null = null

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
   * The returned promise always resolves with the final state; failures are classified
   * rather than thrown, because the status card is the product surface for a failure.
   */
  async check(reason: CheckReason = 'manual'): Promise<DshConnectionState> {
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

    const controller = new AbortController()
    this.controller = controller
    let dshHome = ''
    try {
      dshHome = this.resolveDshHome(config)
    } catch (error) {
      this.controller = null
      return this.setState({
        ...this.state,
        status: 'FAILED',
        detail: { code: 'INTERNAL_ERROR', message: '无法创建 DSH 工作目录。', raw: (error as Error)?.message ?? null },
        lastCheckedAt: now().toISOString(),
      })
    }

    this.inflight = (async () => {
      const outcome = await runProbe({
        dshHome,
        profile: config.dsh.profile,
        provider: config.dsh.provider,
        model: config.dsh.model,
        timeoutMs: config.dsh.probeTimeoutMs,
        cwd: path.join(this.deps.userDataDir, 'workspace'),
        entry,
        signal: controller.signal,
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
      this.deps.logger.info('dsh.probe.end', {
        reason,
        status: outcome.status,
        code: outcome.detail.code,
        durationMs: outcome.durationMs,
        serverInfo: outcome.serverInfo,
        runtimeExitCode: outcome.runtimeExitCode,
        raw: outcome.detail.raw ?? null,
      })
      this.inflight = null
      this.controller = null
      return this.setState(final)
    })()

    return this.inflight
  }

  /** Cancel a running probe; the runtime this probe started is closed by the probe itself. */
  cancel(reason = 'cancel'): void {
    if (!this.controller) return
    this.deps.logger.warn('dsh.probe.cancel', { reason })
    this.controller.abort()
  }
}
