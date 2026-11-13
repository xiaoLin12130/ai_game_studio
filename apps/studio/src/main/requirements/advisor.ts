/**
 * The advisor: a project's conversation with DSH.
 *
 * A conversation is not a task. A task has an acceptance contract and a terminal state; a
 * conversation is open-ended and can be resumed indefinitely. They share the runtime and the
 * session machinery, and nothing else.
 *
 * The runtime is leased per turn and released when the turn ends. Holding one open for the
 * life of a conversation would pin a subprocess for a user who is thinking, and the SDK
 * restores history from the persisted session anyway.
 */
import crypto from 'node:crypto'
import type { RuntimeSupervisor, RuntimeLease } from '../runtime/supervisor'
import type { AttachmentService } from './attachments'
import type { ContextCompiler } from './context'
import type { RequirementStore } from './store'
import type { AttachmentRecord, ConversationRecord, MessageRecord } from './types'

export interface AdvisorLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface AdvisorOptions {
  store: RequirementStore
  supervisor: RuntimeSupervisor
  compiler: ContextCompiler
  attachments: AttachmentService
  logger: AdvisorLogger
  /** Project lookup, so a conversation cannot be created for a project that is not there. */
  projectExists: (projectId: string) => boolean
  /** Project facts and open questions, read from the project's own state. */
  projectContext: (projectId: string) => { facts: string[]; openQuestions: string[]; rules: { title: string; content: string }[] }
  /**
   * Make sure the runtime profile can actually serve a model.
   *
   * A task checks this before it starts; the advisor has to do the same, or the first
   * conversation in a fresh install fails with a runtime that never answers.
   */
  ensureProfile?: () => { ok: boolean; detail: string }
  /** How long one advisor turn may run. */
  turnTimeoutMs?: number
}

export interface TurnResult {
  ok: boolean
  conversationId: string
  sessionId: string | null
  /** Assistant text produced this turn. */
  reply: string
  /** Tool calls the runtime made, in order. */
  toolCalls: { name: string; arguments: string }[]
  error: string | null
  /** True when the turn was cut short by the deadline. */
  timedOut: boolean
}

const DEFAULT_TURN_TIMEOUT = 180000

export class AdvisorService {
  readonly #options: AdvisorOptions
  readonly #store: RequirementStore
  readonly #logger: AdvisorLogger
  readonly #timeout: number

  constructor(options: AdvisorOptions) {
    this.#options = options
    this.#store = options.store
    this.#logger = options.logger
    this.#timeout = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT
  }

  createConversation(projectId: string, title: string): ConversationRecord {
    if (!this.#options.projectExists(projectId)) throw new Error('unknown project: ' + projectId)
    const trimmed = title.trim()
    if (trimmed.length === 0) throw new Error('a conversation needs a title')
    return this.#store.createConversation({ projectId, title: trimmed })
  }

  listConversations(projectId: string): ConversationRecord[] {
    return this.#store.listConversations(projectId)
  }

  getConversation(projectId: string, conversationId: string): ConversationRecord | null {
    return this.#store.getConversation(projectId, conversationId)
  }

  listMessages(projectId: string, conversationId: string, limit = 200): MessageRecord[] {
    const conversation = this.#store.getConversation(projectId, conversationId)
    if (!conversation) return []
    return this.#store.listMessages(conversationId, { limit })
  }

  /**
   * Send one user message and wait for the advisor's turn to finish.
   *
   * The user's message is stored before the runtime is touched, so a failed turn still
   * leaves the user's own words in the record. That is the difference between "the advisor
   * did not answer" and "your message was lost".
   */
  async send(input: {
    projectId: string
    conversationId: string
    text: string
    attachmentIds?: string[]
  }): Promise<TurnResult> {
    const conversation = this.#store.getConversation(input.projectId, input.conversationId)
    if (!conversation) {
      return { ok: false, conversationId: input.conversationId, sessionId: null, reply: '', toolCalls: [], error: '会话不存在或不属于该项目。', timedOut: false }
    }
    const text = input.text.trim()
    if (text.length === 0) {
      return { ok: false, conversationId: conversation.id, sessionId: null, reply: '', toolCalls: [], error: '消息不能为空。', timedOut: false }
    }

    this.#store.appendMessage({ conversationId: conversation.id, role: 'user', kind: 'text', content: text })

    const attachments: AttachmentRecord[] = (input.attachmentIds ?? [])
      .map((attachmentId) => this.#store.getAttachment(input.projectId, attachmentId))
      .filter((a): a is AttachmentRecord => a !== null)

    const project = this.#options.projectContext(input.projectId)
    const compiled = this.#options.compiler.compile({
      project: { id: input.projectId, name: conversation.title, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' },
      userMessage: text,
      rules: project.rules,
      facts: project.facts,
      openQuestions: project.openQuestions,
      drafts: this.#store.listDrafts(input.projectId),
      history: this.#store.listMessages(conversation.id, { limit: 20 }),
      attachments,
      purpose: 'advisor-turn',
    })
    this.#store.recordContext({
      projectId: input.projectId,
      conversationId: conversation.id,
      purpose: 'advisor-turn',
      sources: compiled.sources,
      size: compiled.size,
    })

    const profile = this.#options.ensureProfile?.() ?? { ok: true, detail: 'no check configured' }
    if (!profile.ok) {
      const message = '运行时配置尚未就绪：' + profile.detail
      this.#store.appendMessage({ conversationId: conversation.id, role: 'system', kind: 'error', content: message })
      return { ok: false, conversationId: conversation.id, sessionId: null, reply: '', toolCalls: [], error: message, timedOut: false }
    }

    const existing = this.#existingSession(conversation.id)
    const sessionId = existing ?? this.#newSession(conversation.id)
    let lease: RuntimeLease | null = null
    try {
      lease = await this.#options.supervisor.acquire({ taskId: 'advisor:' + conversation.id, isolation: 'readonly', label: conversation.title })
      lease.bindSession(sessionId)
      this.#store.linkSession({ conversationId: conversation.id, sessionId, runtimeId: lease.runtimeId, state: 'ACTIVE' })

      // A session that already exists must be restored before it can be prompted — but only
      // when the runtime does not already own it. A pooled runtime keeps the session open
      // between turns, and resuming an open session is rejected outright.
      if (existing) {
        try {
          await lease.client.resumeSession(sessionId)
        } catch (error) {
          const message = String((error as Error)?.message ?? error)
          if (!/already open|already exists/i.test(message)) throw error
          this.#logger.info('advisor.session.already-open', { conversationId: conversation.id, sessionId })
        }
      }

      const blocks: Record<string, unknown>[] = [{ type: 'text', text: compiled.text }]
      for (const attachment of attachments) {
        if (attachment.kind !== 'image') continue
        const inline = this.#options.attachments.readForInline(input.projectId, attachment.id)
        if (inline.ok) blocks.push({ type: 'image', data: inline.data, mimeType: inline.mime })
      }

      const subscription = (lease.client.subscribeSessionTree?.(sessionId) ?? lease.client.subscribe?.()) as
        | { next(): Promise<unknown>; close(): void }
        | undefined
      if (!subscription) throw new Error('运行时没有提供事件订阅')

      const collected = { reply: '', toolCalls: [] as { name: string; arguments: string }[] }
      const drain = this.#drain(subscription, collected)
      await lease.client.prompt(sessionId, blocks as never)
      const outcome = await drain

      if (outcome.error) {
        this.#store.appendMessage({ conversationId: conversation.id, role: 'system', kind: 'error', content: outcome.error, sessionId })
        this.#store.linkSession({ conversationId: conversation.id, sessionId, runtimeId: lease.runtimeId, state: 'FAILED' })
        return { ok: false, conversationId: conversation.id, sessionId, reply: collected.reply, toolCalls: collected.toolCalls, error: outcome.error, timedOut: outcome.timedOut }
      }

      if (collected.reply.trim().length > 0) {
        this.#store.appendMessage({ conversationId: conversation.id, role: 'assistant', kind: 'text', content: collected.reply, sessionId })
      }
      for (const call of collected.toolCalls) {
        this.#store.appendMessage({ conversationId: conversation.id, role: 'tool', kind: 'tool-call', content: call.name + ' ' + call.arguments, sessionId })
      }
      this.#store.linkSession({ conversationId: conversation.id, sessionId, runtimeId: lease.runtimeId, state: 'ENDED' })
      return { ok: true, conversationId: conversation.id, sessionId, reply: collected.reply, toolCalls: collected.toolCalls, error: null, timedOut: false }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.#logger.error('advisor.turn.failed', { conversationId: conversation.id, error: message })
      this.#store.appendMessage({ conversationId: conversation.id, role: 'system', kind: 'error', content: message, sessionId })
      this.#store.linkSession({ conversationId: conversation.id, sessionId, runtimeId: lease?.runtimeId ?? null, state: 'FAILED' })
      return { ok: false, conversationId: conversation.id, sessionId, reply: '', toolCalls: [], error: message, timedOut: false }
    } finally {
      if (lease) {
        try {
          await lease.release('advisor-turn-finished')
        } catch (error) {
          this.#logger.warn('advisor.lease.release-failed', { error: String((error as Error)?.message ?? error) })
        }
      }
    }
  }

  /**
   * The session this conversation already has, or null on the first turn.
   *
   * Stable per conversation so the runtime can restore its history: a new id every turn
   * would make every turn a fresh conversation with no memory.
   */
  #existingSession(conversationId: string): string | null {
    const links = this.#store.listSessionLinks(conversationId)
    const usable = links.find((link) => link.state === 'ACTIVE' || link.state === 'ENDED')
    return usable ? usable.sessionId : null
  }

  #newSession(conversationId: string): string {
    return 'advisor-' + conversationId + '-' + crypto.randomUUID().slice(0, 8)
  }

  /** Collect the turn's events until it ends or the deadline passes. */
  async #drain(
    subscription: { next(): Promise<unknown>; close(): void },
    collected: { reply: string; toolCalls: { name: string; arguments: string }[] },
  ): Promise<{ error: string | null; timedOut: boolean }> {
    const deadline = Date.now() + this.#timeout
    let sawWork = false
    try {
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return { error: sawWork ? null : '顾问没有在 ' + this.#timeout + 'ms 内开始回应。', timedOut: true }
        }
        const next = await Promise.race([
          subscription.next(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(remaining, 15000))),
        ])
        if (next === null) continue
        const notification = next as { method?: string; params?: Record<string, unknown> }
        this.#options.logger.info('advisor.notification', { method: notification?.method ?? null })
        if (notification?.method !== 'session.event') continue
        const event = notification.params?.event as Record<string, unknown> | undefined
        const payload = (event?.data ?? event) as Record<string, unknown> | undefined
        const type = String(event?.type ?? '')
        this.#options.logger.info('advisor.event', { type, detail: type === 'assistant/attempt' ? JSON.stringify(payload).slice(0, 600) : undefined })
        if (type === 'step/start') sawWork = true
        if (type === 'assistant/message') {
          for (const block of (payload?.message as { content?: Record<string, unknown>[] } | undefined)?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') collected.reply += block.text
            if (block.type === 'tool-call' && typeof block.name === 'string') {
              collected.toolCalls.push({ name: block.name, arguments: String(block.arguments ?? '') })
            }
          }
        }
        if (type === 'turn/end') return { error: null, timedOut: false }
      }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error), timedOut: false }
    } finally {
      try {
        subscription.close()
      } catch {
        /* already closed */
      }
    }
  }
}
