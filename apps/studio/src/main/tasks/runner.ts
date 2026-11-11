/**
 * TaskRunner: the only place that moves a task through its lifecycle.
 *
 * The rule this file exists to enforce: a model's message is evidence, never a state
 * change. A run reaching idle only earns a trip to VERIFYING; SUCCEEDED is decided by the
 * verifier, and nothing else in the app can write that status.
 *
 * Interrupt is a runtime close, because DSH has no wire-level cancel. That is why writable
 * tasks get their own runtime (see RuntimeSupervisor) and why a resume is a new attempt
 * carrying the old session id rather than a silent new conversation.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { RuntimeLease, RuntimeSupervisor } from '../runtime/supervisor'
import { statusForAction } from './machine'
import type { TaskStore } from './store'
import type { AttemptRecord, TaskRecord, TaskStatus, TransitionSource } from './types'

export interface RunnerLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface RunnerOptions {
  store: TaskStore
  supervisor: RuntimeSupervisor
  logger: RunnerLogger
  /** Where full event streams are written (relative to here is recorded in the db). */
  recordsDir: string
  /** Prompt text applied to the task goal. */
  buildPrompt?: (task: TaskRecord, attempt: AttemptRecord) => string
  /** How long one attempt may run before Studio gives up on it. */
  runTimeoutMs?: number
  /** Test seam: override how completion is observed. */
  waitForIdle?: (client: unknown, sessionId: string, timeoutMs: number, onNotification: (n: unknown) => void) => Promise<{ idle: boolean; error?: string }>
}

export interface ActiveRun {
  taskId: string
  attemptId: string
  sessionId: string
  lease: RuntimeLease
  stopping: boolean
}

const DEFAULT_PROMPT = (task: TaskRecord) => task.goal

export class TaskRunner {
  readonly #store: TaskStore
  readonly #supervisor: RuntimeSupervisor
  readonly #logger: RunnerLogger
  readonly #recordsDir: string
  readonly #buildPrompt: (task: TaskRecord, attempt: AttemptRecord) => string
  readonly #runTimeoutMs: number
  readonly #waitForIdle?: RunnerOptions['waitForIdle']
  readonly #active = new Map<string, ActiveRun>()

  constructor(options: RunnerOptions) {
    this.#store = options.store
    this.#supervisor = options.supervisor
    this.#logger = options.logger
    this.#recordsDir = options.recordsDir
    this.#buildPrompt = options.buildPrompt ?? DEFAULT_PROMPT
    this.#runTimeoutMs = options.runTimeoutMs ?? 600000
    this.#waitForIdle = options.waitForIdle
    fs.mkdirSync(this.#recordsDir, { recursive: true })
    this.#supervisor.on('runtime:exited', (event: { runtimeId: string; reason: string; error: string | null; taskIds: string[] }) => {
      void this.#onRuntimeExited(event)
    })
  }

  get activeTasks(): string[] {
    return [...this.#active.keys()]
  }

  active(taskId: string): ActiveRun | undefined {
    return this.#active.get(taskId)
  }

  // ------------------------------------------------------------ user actions

  async start(taskId: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    const next = statusForAction(task.status, 'start')
    if (!next) throw new Error('task ' + taskId + ' cannot start from ' + task.status)
    this.#move(taskId, next, { reason: 'user started the task', source: 'user' })
    // Execute without blocking the caller: the IPC call returns the QUEUED state and the
    // UI follows transitions through state events.
    void this.#execute(taskId, 'new').catch((error) => this.#fail(taskId, 'INTERNAL', String(error?.message ?? error)))
    return this.#require(taskId)
  }

  async retry(taskId: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    const next = statusForAction(task.status, 'retry')
    if (!next) throw new Error('task ' + taskId + ' cannot retry from ' + task.status)
    this.#move(taskId, next, { reason: 'user retried the task', source: 'user', attemptId: task.currentAttemptId ?? undefined })
    void this.#execute(taskId, 'new').catch((error) => this.#fail(taskId, 'INTERNAL', String(error?.message ?? error)))
    return this.#require(taskId)
  }

  async resume(taskId: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    const next = statusForAction(task.status, 'resume')
    if (!next) throw new Error('task ' + taskId + ' cannot resume from ' + task.status)
    this.#move(taskId, next, { reason: 'user resumed the task', source: 'user' })
    void this.#execute(taskId, 'resume').catch((error) => this.#fail(taskId, 'RESUME_FAILED', String(error?.message ?? error)))
    return this.#require(taskId)
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    const next = statusForAction(task.status, 'cancel')
    if (!next) throw new Error('task ' + taskId + ' cannot be cancelled from ' + task.status)
    const active = this.#active.get(taskId)
    if (active) await this.#stopActive(active, 'cancelled')
    this.#move(taskId, next, { reason: 'user cancelled the task', source: 'user' })
    return this.#require(taskId)
  }

  /**
   * Stop a running task. Repeated calls are harmless: the second one sees INTERRUPTING and
   * returns the same state instead of issuing a second close.
   */
  async stop(taskId: string): Promise<TaskRecord> {
    const task = this.#require(taskId)
    if (task.status === 'INTERRUPTING' || task.status === 'INTERRUPTED') return task
    const next = statusForAction(task.status, 'stop')
    if (!next) throw new Error('task ' + taskId + ' cannot stop from ' + task.status)
    this.#move(taskId, next, { reason: 'user stopped the task', source: 'user' })
    const active = this.#active.get(taskId)
    if (active) await this.#stopActive(active, 'interrupted')
    return this.#require(taskId)
  }

  // ------------------------------------------------------------ execution

  async #execute(taskId: string, mode: 'new' | 'resume'): Promise<void> {
    if (this.#active.has(taskId)) return // single flight per task
    const task = this.#require(taskId)
    // A resume is already in RESUMING; a fresh run has to pass through PREPARING first.
    if (task.status !== 'RESUMING') {
      this.#move(taskId, 'PREPARING', { reason: 'preparing to run', source: 'scheduler' })
    }

    const isolation = task.isolation
    const lease = await this.#supervisor.acquire({ taskId, isolation, label: task.title })

    let sessionId: string
    let attempt: AttemptRecord
    try {
      if (mode === 'resume') {
        const previous = this.#latestSession(taskId)
        if (!previous) throw new Error('no persisted session to resume')
        sessionId = previous.id
        await lease.client.resumeSession(sessionId)
        attempt = this.#store.createAttempt({
          id: 'att-' + taskId + '-' + this.#store.nextAttemptNo(taskId),
          taskId,
          attemptNo: this.#store.nextAttemptNo(taskId),
          sessionId,
          runtimeId: lease.runtimeId,
        })
        this.#store.upsertSession({ id: sessionId, taskId, attemptId: attempt.id, runtimeId: lease.runtimeId, state: 'ACTIVE' })
        this.#logger.info('task.resumed', { taskId, sessionId, attemptId: attempt.id })
      } else {
        const attemptNo = this.#store.nextAttemptNo(taskId)
        attempt = this.#store.createAttempt({
          id: 'att-' + taskId + '-' + attemptNo,
          taskId,
          attemptNo,
          runtimeId: lease.runtimeId,
        })
        sessionId = 'studio-' + taskId + '-a' + attemptNo
        this.#store.attachSessionToAttempt(attempt.id, sessionId)
        this.#store.upsertSession({ id: sessionId, taskId, attemptId: attempt.id, runtimeId: lease.runtimeId, state: 'ACTIVE' })
      }
    } catch (error) {
      // A failed resume is recorded as such; it never silently becomes a new session.
      this.#store.upsertSession({ id: this.#latestSession(taskId)?.id ?? 'unknown', taskId, attemptId: 'unknown', state: 'RESUME_FAILED', lastError: String((error as Error)?.message ?? error) })
      await lease.release('resume-failed')
      this.#fail(taskId, mode === 'resume' ? 'RESUME_FAILED' : 'PREPARE_FAILED', String((error as Error)?.message ?? error))
      return
    }

    lease.bindSession(sessionId)
    this.#active.set(taskId, { taskId, attemptId: attempt.id, sessionId, lease, stopping: false })
    this.#move(taskId, 'RUNNING', { reason: 'runtime ready, prompt queued', source: 'scheduler', sessionId, attemptId: attempt.id })
    this.#store.appendEvent({ taskId, attemptId: attempt.id, kind: 'run.started', summary: 'session ' + sessionId })

    const recordPath = path.join(this.#recordsDir, taskId + '-' + attempt.id + '.jsonl')
    const recordStream = fs.createWriteStream(recordPath, { flags: 'a' })

    try {
      const prompt = this.#buildPrompt(task, attempt)
      // Subscribe first. A run can emit its entire event stream within milliseconds, and
      // subscribing after the prompt silently loses the evidence the verifier needs.
      const subscription = this.#subscribe(lease.client, sessionId)
      await lease.client.prompt(sessionId, [{ type: 'text', text: prompt }])
      const observed = await this.#observe(lease.client, sessionId, attempt.id, recordStream, subscription)
      this.#store.appendEvent({
        taskId,
        attemptId: attempt.id,
        kind: 'run.observed',
        summary:
          'events=' + observed.events.length +
          ' idle=' + observed.idle +
          ' error=' + String(observed.error ?? '') +
          ' types=' + JSON.stringify(observed.events.map((e) => String((e as { type?: string }).type ?? '?'))).slice(0, 400) +
          ' last=' + JSON.stringify(observed.events[observed.events.length - 1] ?? null).slice(0, 900),
      })
      recordStream.close()
      this.#store.endAttempt({
        attemptId: attempt.id,
        status: observed.error ? 'FAILED' : this.#require(taskId).status === 'INTERRUPTING' ? 'INTERRUPTED' : 'ENDED',
        errorCode: observed.error ? 'RUN_FAILED' : null,
        errorMessage: observed.error ?? null,
        recordPath: path.relative(this.#recordsDir, recordPath),
      })
      this.#active.delete(taskId)

      const current = this.#require(taskId)
      if (current.status === 'INTERRUPTING') {
        this.#move(taskId, 'INTERRUPTED', { reason: 'stop requested', source: 'runtime', sessionId, attemptId: attempt.id })
        this.#store.upsertSession({ id: sessionId, taskId, attemptId: attempt.id, state: 'INTERRUPTED' })
        await lease.release('interrupted')
        return
      }
      if (observed.error) {
        this.#fail(taskId, 'RUN_FAILED', observed.error)
        await lease.release('run-failed')
        return
      }

      // A run that ended is not a task that succeeded.
      this.#move(taskId, 'VERIFYING', { reason: 'run finished, verifying', source: 'runtime', sessionId, attemptId: attempt.id })
      const verdict = await Promise.resolve(this.#verify(taskId, attempt.id, observed.events))
      this.#store.recordVerification({ taskId, attemptId: attempt.id, ok: verdict.ok, code: verdict.code ?? null, detail: verdict.detail ?? null })
      if (verdict.ok) {
        this.#move(taskId, 'SUCCEEDED', { reason: 'acceptance passed', source: 'verifier', sessionId, attemptId: attempt.id })
        this.#store.upsertSession({ id: sessionId, taskId, attemptId: attempt.id, state: 'ENDED' })
      } else {
        this.#fail(taskId, verdict.code ?? 'ACCEPTANCE_FAILED', verdict.detail ?? 'acceptance failed', { sessionId, attemptId: attempt.id })
      }
      await lease.release(verdict.ok ? 'completed' : 'acceptance-failed')
    } catch (error) {
      try {
        recordStream.close()
      } catch {
        /* already closed */
      }
      this.#active.delete(taskId)
      this.#store.endAttempt({ attemptId: attempt.id, status: 'FAILED', errorCode: 'RUN_ERROR', errorMessage: String((error as Error)?.message ?? error), recordPath: path.relative(this.#recordsDir, recordPath) })
      this.#fail(taskId, 'RUN_ERROR', String((error as Error)?.message ?? error))
      await lease.release('run-error')
    }
  }

  /** Open the notification stream for one session, before its prompt is queued. */
  #subscribe(client: { subscribeSessionTree?: (sessionId: string) => unknown; subscribe?: () => unknown }, sessionId: string): { next(): Promise<unknown>; close(): void } | undefined {
    return (client.subscribeSessionTree?.(sessionId) ?? client.subscribe?.()) as { next(): Promise<unknown>; close(): void } | undefined
  }

  /** Watch the session until it goes idle, the runtime dies, or the deadline passes. */
  async #observe(
    client: { subscribeSessionTree?: (sessionId: string) => unknown; subscribe?: () => unknown },
    sessionId: string,
    attemptId: string,
    stream: fs.WriteStream,
    preopened?: { next(): Promise<unknown>; close(): void },
  ): Promise<{ idle: boolean; error?: string; events: Record<string, unknown>[] }> {
    const events: Record<string, unknown>[] = []
    const onNotification = (notification: unknown) => {
      const n = notification as { method?: string; params?: Record<string, unknown> }
      stream.write(JSON.stringify({ at: new Date().toISOString(), method: n?.method ?? null, params: n?.params ?? null }) + '\n')
      if (n?.method === 'session.event' && n.params?.event) events.push(n.params.event as Record<string, unknown>)
    }
    if (this.#waitForIdle) {
      const result = await this.#waitForIdle(client, sessionId, this.#runTimeoutMs, onNotification)
      return { idle: result.idle, error: result.error, events }
    }
    const subscription = (preopened ?? (client.subscribeSessionTree?.(sessionId) ?? client.subscribe?.())) as
      | ({ next(): Promise<unknown>; close(): void } & AsyncIterable<unknown>)
      | undefined
    if (!subscription) return { idle: false, error: 'no notification subscription available', events }
    try {
      const deadline = Date.now() + this.#runTimeoutMs
      // A session that has not started working yet is already "idle". Treating that first
      // idle as the end of the turn ends the run before the prompt is even processed — the
      // task then "finishes" in 100 ms with no evidence. Only an idle that follows real
      // activity closes the turn.
      let sawWork = false
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          // Nothing ever ran: that is a finished turn with no evidence, which the verifier
          // reports as NO_EVENTS rather than as a timeout.
          if (!sawWork && events.length === 0) return { idle: true, events }
          return { idle: false, error: 'attempt exceeded ' + this.#runTimeoutMs + 'ms', events }
        }
        const next = await Promise.race([
          subscription.next(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(remaining, 30000))),
        ])
        if (next === null) continue
        onNotification(next)
        const n = next as { method?: string; params?: Record<string, unknown> }
        if (n?.method === 'session.event') sawWork = true
        if (n?.method === 'session.status') {
          const status = String(n.params?.status ?? '')
          if (status && status !== 'idle') sawWork = true
          if (status === 'idle' && sawWork) return { idle: true, events }
          if (status === 'error') return { idle: false, error: String(n.params?.message ?? 'session error'), events }
        }
      }
    } catch (error) {
      return { idle: false, error: String((error as Error)?.message ?? error), events }
    } finally {
      try {
        subscription.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Studio's own acceptance rules. Deliberately independent of anything the model said.
   */
  #verify(taskId: string, attemptId: string, events: Record<string, unknown>[]): { ok: boolean; code?: string; detail?: string } {
    const task = this.#require(taskId)
    const spec = task.acceptance
    if (spec.requireCompletedRun && events.length === 0) {
      return { ok: false, code: 'NO_EVENTS', detail: 'the run produced no events' }
    }
    const toolCalls = new Map<string, boolean>()
    for (const event of events) {
      // Session events carry their payload under `data`; accept a bare message too so the
      // verifier does not depend on one envelope shape.
      const envelope = event as { data?: Record<string, unknown>; message?: Record<string, unknown> }
      const message = (envelope.data?.message ?? envelope.message) as Record<string, unknown> | undefined
      if (!message || message.role !== 'tool') continue
      const name = String((message as { name?: string }).name ?? '')
      const failed = (message as { isError?: boolean }).isError === true
      toolCalls.set(name, !failed)
    }
    for (const required of spec.requiredTools ?? []) {
      if (!toolCalls.has(required)) {
        return { ok: false, code: 'TOOL_NOT_CALLED', detail: 'required tool was never called: ' + required }
      }
      if (toolCalls.get(required) === false) {
        return { ok: false, code: 'TOOL_FAILED', detail: 'required tool failed: ' + required }
      }
    }
    if (spec.requireResponse) {
      const lastAssistant = [...events].reverse().find((event) => {
        const envelope = event as { data?: Record<string, unknown>; message?: Record<string, unknown> }
        const message = (envelope.data?.message ?? envelope.message) as Record<string, unknown> | undefined
        return message?.role === 'assistant'
      })
      if (!lastAssistant) return { ok: false, code: 'NO_RESPONSE', detail: 'no assistant message was produced' }
    }
    return { ok: true }
  }

  // ------------------------------------------------------------ failure paths

  #move(taskId: string, to: TaskStatus, intent: { reason: string; source: TransitionSource; sessionId?: string; attemptId?: string; errorCode?: string | null }): TaskRecord {
    const updated = this.#store.transition({ taskId, to, reason: intent.reason, source: intent.source, sessionId: intent.sessionId ?? null, attemptId: intent.attemptId ?? null, errorCode: intent.errorCode ?? null })
    this.#logger.info('task.transition', { taskId, to, reason: intent.reason, source: intent.source })
    this.#supervisor.emit('task:changed', { taskId, status: updated.status })
    return updated
  }

  #fail(taskId: string, code: string, message: string, extra?: { sessionId?: string; attemptId?: string }): void {
    const task = this.#store.getTask(taskId)
    if (!task) return
    // Do not overwrite a state that already explains itself: a task the runtime dropped is
    // INTERRUPTED on purpose, and the generic run error that follows is a consequence, not
    // a better explanation.
    const settled: TaskStatus[] = ['FAILED', 'CANCELLED', 'SUCCEEDED', 'INTERRUPTED']
    if (settled.includes(task.status)) {
      this.#logger.warn('task.fail.skipped', { taskId, status: task.status, code })
      return
    }
    this.#move(taskId, 'FAILED', { reason: message, source: 'system', errorCode: code, sessionId: extra?.sessionId, attemptId: extra?.attemptId })
    this.#store.appendEvent({ taskId, kind: 'task.failed', summary: code + ': ' + message })
  }

  async #stopActive(active: ActiveRun, reason: 'interrupted' | 'cancelled'): Promise<void> {
    if (active.stopping) return // repeated stop clicks collapse into one close
    active.stopping = true
    try {
      await active.lease.release(reason)
    } finally {
      this.#active.delete(active.taskId)
    }
  }

  async #onRuntimeExited(event: { runtimeId: string; reason: string; error: string | null; taskIds: string[] }): Promise<void> {
    for (const taskId of event.taskIds) {
      const active = this.#active.get(taskId)
      if (!active) continue
      this.#active.delete(taskId)
      try {
        this.#store.endAttempt({ attemptId: active.attemptId, status: 'INTERRUPTED', errorCode: 'RUNTIME_EXITED', errorMessage: event.error })
        const task = this.#store.getTask(taskId)
        if (task && (task.status === 'RUNNING' || task.status === 'PREPARING')) {
          this.#move(taskId, 'INTERRUPTED', { reason: 'runtime exited: ' + (event.error ?? event.reason), source: 'runtime', errorCode: 'RUNTIME_EXITED' })
          this.#store.upsertSession({ id: active.sessionId, taskId, attemptId: active.attemptId, state: 'INTERRUPTED' })
        }
      } catch (error) {
        this.#logger.error('task.runtime-exit.handling-failed', { taskId, error: String((error as Error)?.message ?? error) })
      }
    }
  }

  /**
   * On startup, tasks that were mid-flight are provably not running any more. They are
   * marked INTERRUPTED (not failed) so the user can resume them.
   */
  async recoverOnStartup(): Promise<{ recovered: string[] }> {
    const recovered: string[] = []
    for (const task of this.#store.listUnfinished()) {
      // A run that was in flight has a session worth resuming. A queued or verifying task
      // does not: it either never started or already finished its run, so marking it
      // INTERRUPTED would promise a resume that cannot work. Those become FAILED(APP_EXIT)
      // and the user can retry, which starts a fresh attempt.
      const resumable: TaskStatus[] = ['RUNNING', 'PREPARING', 'RESUMING', 'INTERRUPTING']
      const target: TaskStatus = resumable.includes(task.status) ? 'INTERRUPTED' : 'FAILED'
      if (!this.#store.canMove(task.id, target)) continue
      this.#move(task.id, target, { reason: 'application restarted while the task was ' + task.status, source: 'recovery', errorCode: target === 'FAILED' ? 'APP_EXIT' : null })
      recovered.push(task.id)
    }
    if (recovered.length > 0) this.#logger.info('task.recovery', { recovered })
    return { recovered }
  }

  #latestSession(taskId: string) {
    const sessions = this.#store.listSessions(taskId)
    return sessions.length > 0 ? sessions[sessions.length - 1] : null
  }

  #require(taskId: string): TaskRecord {
    const task = this.#store.getTask(taskId)
    if (!task) throw new Error('unknown task: ' + taskId)
    return task
  }
}
