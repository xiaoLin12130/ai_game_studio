/**
 * RuntimeSupervisorManager: decides which DSH runtime a task runs on, and owns its life.
 *
 * The policy is driven by one measured fact: DSH has no wire-level cancel, so interrupting
 * a task means closing the runtime it runs on. That makes sharing a runtime safe only for
 * work that cannot be interrupted destructively — read-only analysis. Anything that may
 * write gets its own runtime, so stopping one task can never stop another.
 *
 * There is no "one runtime per project" or "one runtime per role" binding: runtimes are
 * started on demand, reused while they are healthy, and reclaimed when their last task
 * ends or the app quits.
 */
import { EventEmitter } from 'node:events'
import { childEnvironment, loadSdk, sdkEntryPath, type HarnessClientLike } from '../dsh/probe'
import type { DshEntry } from '../dsh/locate'
import type { TaskIsolation } from '../tasks/types'

export type RuntimeState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed'

/**
 * The session-level surface the task runner needs. It is the real HarnessClient; the
 * optional members on HarnessClientLike exist only so the readiness probe's test seam can
 * stand in without implementing them.
 */
export interface RuntimeClient extends HarnessClientLike {
  prompt(sessionId: string, contentBlocks: unknown[]): Promise<string>
  resumeSession(sessionId: string): Promise<void>
  subscribeSessionTree?(sessionId: string): unknown
}

export interface RuntimeHandle {
  id: string
  isolation: TaskIsolation
  state: RuntimeState
  client: RuntimeClient
  pid: number | null
  sessions: Set<string>
  taskIds: Set<string>
  startedAt: string
  lastError: string | null
  /** Resolves when the runtime exits unexpectedly; used to fail its tasks fast. */
  death: Promise<{ runtimeId: string; reason: string; error: string | null }>
  /**
   * The one close operation for this runtime. Every later request awaits this same
   * promise instead of returning early, so a shutdown never reports a close that is
   * still in progress as either done or failed.
   */
  closePromise: Promise<CloseResult> | null
}

export type CloseResult = { ok: true } | { ok: false; error: string; timedOut: boolean }

export interface RuntimeLease {
  runtimeId: string
  isolation: TaskIsolation
  client: RuntimeClient
  /** Register the DSH session this lease will drive, so the supervisor can report it. */
  bindSession(sessionId: string): void
  release(reason: string): Promise<void>
  released: boolean
}

export interface SupervisorLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface SupervisorOptions {
  logger: SupervisorLogger
  dshHome: string
  profile: string
  provider: string
  model: string
  cwd: string
  entry: DshEntry
  /** How many read-only runtimes may exist. One is enough: sessions are independent. */
  readonlyRuntimes?: number
  /** How long a runtime may take to start before the lease fails. */
  startTimeoutMs?: number
  /** How long a close may take before it is reported as failed (never as success). */
  closeTimeoutMs?: number
  /** Cordis patches applied to every runtime this supervisor starts. */
  patches?: string[]
  /** Test seam: build a client without spawning the real SDK. */
  clientFactory?: (options: Record<string, unknown>) => HarnessClientLike
}

export class RuntimeStartError extends Error {
  readonly runtimeId: string
  constructor(runtimeId: string, message: string) {
    super(message)
    this.name = 'RuntimeStartError'
    this.runtimeId = runtimeId
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, ms)))

export class RuntimeSupervisor extends EventEmitter {
  readonly #options: SupervisorOptions
  readonly #runtimes = new Map<string, RuntimeHandle>()
  readonly #busy = new Map<string, number>()
  #serial = 0
  #closed = false

  constructor(options: SupervisorOptions) {
    super()
    this.#options = options
  }

  get runtimes(): RuntimeHandle[] {
    return [...this.#runtimes.values()]
  }

  /** Runtime capacity summary for the UI's technical panel. */
  snapshot(): { id: string; isolation: TaskIsolation; state: RuntimeState; pid: number | null; sessions: number; leases: number }[] {
    return this.runtimes.map((runtime) => ({
      id: runtime.id,
      isolation: runtime.isolation,
      state: runtime.state,
      pid: runtime.pid,
      sessions: runtime.sessions.size,
      leases: this.#busy.get(runtime.id) ?? 0,
    }))
  }

  #pick(isolation: TaskIsolation): RuntimeHandle | null {
    const candidates = this.runtimes.filter((runtime) => runtime.isolation === isolation && runtime.state === 'ready')
    if (isolation === 'writable') return null // writable work never shares
    const limit = this.#options.readonlyRuntimes ?? 1
    if (candidates.length >= limit) {
      // Reuse the least busy pooled runtime; sessions within one runtime are independent.
      return candidates.sort((a, b) => (this.#busy.get(a.id) ?? 0) - (this.#busy.get(b.id) ?? 0))[0] ?? null
    }
    return null
  }

  async #create(isolation: TaskIsolation): Promise<RuntimeHandle> {
    this.#serial += 1
    const id = 'rt-' + this.#serial.toString().padStart(3, '0')
    const sdk = await loadSdk(sdkEntryPath())
    const options: Record<string, unknown> = {
      dshHome: this.#options.dshHome,
      profile: this.#options.profile,
      initializeTimeoutMs: 60000,
      disposeGraceMs: 4000,
      env: childEnvironment(),
    }
    if (this.#options.entry.bin) options.dshBin = this.#options.entry.bin
    if (this.#options.patches?.length) options.patches = this.#options.patches
    const factory = this.#options.clientFactory ?? ((opts: Record<string, unknown>) => new sdk.HarnessClient(opts))
    const client = factory(options) as RuntimeClient

    let settleDeath: (value: { runtimeId: string; reason: string; error: string | null }) => void = () => {}
    const death = new Promise<{ runtimeId: string; reason: string; error: string | null }>((resolve) => {
      settleDeath = resolve
    })

    const handle: RuntimeHandle = {
      id,
      isolation,
      state: 'starting',
      client,
      pid: null,
      sessions: new Set(),
      taskIds: new Set(),
      startedAt: new Date().toISOString(),
      lastError: null,
      death,
      closePromise: null,
    }

    // The subscription is how a dead runtime announces itself: the async iterator rejects
    // with the exit message when the child goes away.
    const subscription = client.subscribe()
    void (async () => {
      try {
        for await (const _notification of subscription as AsyncIterable<unknown>) {
          this.emit('runtime:notification', { runtimeId: id, notification: _notification })
        }
      } catch (error) {
        const reason = String((error as Error)?.message ?? error).split('\n')[0]
        if (handle.state !== 'closing' && handle.state !== 'closed') {
          handle.state = 'failed'
          handle.lastError = reason
          this.#options.logger.error('runtime.exited', { runtimeId: id, reason })
          settleDeath({ runtimeId: id, reason: 'runtime-exited', error: reason })
          this.emit('runtime:exited', { runtimeId: id, reason, taskIds: this.#tasksOn(id) })
          try {
            subscription.close()
          } catch {
            /* already closed */
          }
        }
      }
    })()

    this.#runtimes.set(id, handle)
    this.#busy.set(id, 0)
    this.#options.logger.info('runtime.start', { runtimeId: id, isolation })

    const timeoutMs = this.#options.startTimeoutMs ?? 90000
    try {
      client.start()
      // The timeout timer must be cleared when the handshake wins, otherwise it keeps the
      // event loop alive for its full duration (and delays a clean process exit).
      let startTimer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          client.initialize({ cwd: this.#options.cwd, provider: this.#options.provider, model: this.#options.model }),
          new Promise<never>((_resolve, reject) => {
            startTimer = setTimeout(() => reject(new RuntimeStartError(id, 'runtime start exceeded ' + timeoutMs + 'ms')), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(startTimer)
      }
      handle.state = 'ready'
      this.#options.logger.info('runtime.ready', { runtimeId: id, isolation })
      return handle
    } catch (error) {
      const startError = String((error as Error)?.message ?? error)
      handle.state = 'failed'
      handle.lastError = startError
      // A failed handshake does not prove the child exited, so cleanup goes through the
      // same close path as a normal shutdown. If that close also fails, the runtime stays
      // in the map and shutdownAll reports it: the start error is kept as the cause and the
      // close error as a separate fact.
      const closed = await this.#close(handle, 'start-failed')
      this.#options.logger.error('runtime.start.failed', {
        runtimeId: id,
        startError,
        closeOk: closed.ok,
        closeError: closed.ok ? null : closed.error,
      })
      throw new RuntimeStartError(id, closed.ok ? startError : startError + ' (cleanup failed: ' + closed.error + ')')
    }
  }

  #tasksOn(runtimeId: string): string[] {
    const runtime = this.#runtimes.get(runtimeId)
    return runtime ? [...runtime.taskIds] : []
  }

  /**
   * Lease a runtime for one attempt. Writable work always gets a fresh runtime; read-only
   * work shares the pool. Throws {@link RuntimeStartError} when no runtime can be started.
   */
  async acquire(input: { taskId: string; isolation: TaskIsolation; label?: string }): Promise<RuntimeLease> {
    if (this.#closed) throw new RuntimeStartError('none', 'supervisor is closed')
    let runtime = input.isolation === 'writable' ? null : this.#pick('readonly')
    if (!runtime) runtime = await this.#create(input.isolation)
    this.#busy.set(runtime.id, (this.#busy.get(runtime.id) ?? 0) + 1)
    runtime.taskIds.add(input.taskId)

    const lease: RuntimeLease = {
      runtimeId: runtime.id,
      isolation: runtime.isolation,
      client: runtime.client,
      released: false,
      bindSession: (sessionId: string) => {
        runtime!.sessions.add(sessionId)
      },
      release: async (reason: string) => {
        if (lease.released) return // idempotent: the UI can double-click stop
        lease.released = true
        const busy = Math.max(0, (this.#busy.get(runtime!.id) ?? 1) - 1)
        this.#busy.set(runtime!.id, busy)
        if (busy === 0) runtime!.taskIds.delete(input.taskId)
        if (runtime!.isolation === 'writable' || busy === 0) {
          const result = await this.#close(runtime!, reason)
          if (!result.ok) {
            this.#options.logger.error('runtime.release.failed', { runtimeId: runtime!.id, reason, error: result.error })
          }
        }
      },
    }
    this.#options.logger.info('runtime.lease', { runtimeId: runtime.id, taskId: input.taskId, isolation: runtime.isolation, label: input.label ?? null })
    return lease
  }

  /**
   * Close one runtime, at most once.
   *
   * The first caller starts the operation and stores its promise; everybody else awaits
   * that same promise. This is what stops a shutdown from declaring a runtime "failed"
   * only because a lease release happened to start closing it first.
   *
   * A close that does not finish inside the bound is a failure, not a quiet success: the
   * SDK close promise can simply never settle, and a resolved race would otherwise mark a
   * live process as clean.
   */
  #close(runtime: RuntimeHandle, reason: string): Promise<CloseResult> {
    if (runtime.closePromise) return runtime.closePromise
    runtime.closePromise = this.#performClose(runtime, reason)
    return runtime.closePromise
  }

  async #performClose(runtime: RuntimeHandle, reason: string): Promise<CloseResult> {
    runtime.state = 'closing'
    const bound = this.#options.closeTimeoutMs ?? 25000
    let closeTimer: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        runtime.client.close().then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => {
          closeTimer = setTimeout(() => resolve('timeout'), bound)
        }),
      ])
      if (outcome === 'timeout') {
        throw new Error('runtime close exceeded ' + bound + 'ms')
      }
      runtime.state = 'closed'
      this.#options.logger.info('runtime.closed', { runtimeId: runtime.id, reason })
      this.#runtimes.delete(runtime.id)
      this.#busy.delete(runtime.id)
      return { ok: true }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      runtime.state = 'failed'
      runtime.lastError = message
      this.#options.logger.error('runtime.close.failed', {
        runtimeId: runtime.id,
        reason,
        error: message,
        timedOut: /exceeded/.test(message),
      })
      // Deliberately kept in the map: a runtime we could not close has to stay visible and
      // count as failed at shutdown, not disappear and be counted as handled.
      return { ok: false, error: message, timedOut: /exceeded/.test(message) }
    } finally {
      clearTimeout(closeTimer)
    }
  }

  async shutdownAll(reason: string): Promise<{ closed: string[]; failed: string[] }> {
    this.#closed = true
    const closed: string[] = []
    const failed: string[] = []
    // Snapshot first: closes that were already started by a lease release are joined here
    // rather than restarted, and runtimes that failed to close stay in the map, so a second
    // shutdown would still see them.
    for (const runtime of [...this.#runtimes.values()]) {
      const result = await this.#close(runtime, reason)
      if (result.ok) closed.push(runtime.id)
      else failed.push(runtime.id)
    }
    if (failed.length > 0) {
      this.#options.logger.error('runtime.shutdown.incomplete', { reason, failed })
    }
    return { closed, failed }
  }
}
