/**
 * Running a research request against the real runtime.
 *
 * The rule this file exists to enforce: a source is something a tool returned, not something
 * the model wrote. A model can produce a convincing URL; treating its prose as a citation is
 * how a fabricated link ends up in a report that looks researched.
 *
 * Research runs as two independent turns, each on its own lease and its own session: one to
 * gather with the web tools, one to write the report from what was gathered. Asking for both
 * in a single turn makes the model spend the whole turn searching and never write; asking for
 * the second turn on the same session gets the prompt accepted and never executed.
 */
import crypto from 'node:crypto'
import type { RuntimeLease, RuntimeSupervisor } from '../runtime/supervisor'
import type { ResearchSource } from './types'

export interface ResearchLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface ResearchExecutorOptions {
  supervisor: RuntimeSupervisor
  logger: ResearchLogger
  /** Project context, so the research knows what game it is about. */
  projectContext: (projectId: string) => { name: string; engine: string; platform: string; facts: string[] }
  /** How long one research turn may run. */
  timeoutMs?: number
}

export interface ResearchRunResult {
  ok: boolean
  markdown: string
  sources: ResearchSource[]
  error: string | null
  /** Tool calls the runtime made, in order, for the record. */
  toolCalls: { name: string; arguments: string }[]
  /** True when at least one verified source exists. */
  hasVerifiedSources: boolean
}

interface Collected {
  reply: string
  calls: { name: string; arguments: string }[]
  results: { name: string; content: string; ok: boolean; at: string }[]
}

const DEFAULT_TIMEOUT = 300000

/** Extract URLs from a tool result payload, whatever shape the provider returned. */
export function urlsIn(text: string): string[] {
  const found = [...text.matchAll(/https?:\/\/[^\s"'<>)\]}]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''))
  return [...new Set(found)]
}

/**
 * Build sources from tool calls and results.
 *
 * A fetch that returned content is a verified source. A search that returned results is a
 * list of verified discovery records — the URL really came back from the search — but its
 * body was never read, which the status records.
 */
export function sourcesFromToolTraffic(
  calls: { name: string; arguments: string }[],
  results: { name: string; content: string; ok: boolean; at: string }[],
): ResearchSource[] {
  const sources: ResearchSource[] = []
  const seen = new Set<string>()

  const push = (source: ResearchSource) => {
    if (!source.url || seen.has(source.url)) return
    seen.add(source.url)
    sources.push(source)
  }

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    const result = results[i]
    if (!result) continue
    const target = urlsIn(call.arguments ?? '')[0] ?? null

    if (/fetch/i.test(call.name)) {
      push({
        title: target ? titleFromUrl(target) : '抓取的页面',
        url: target ?? '',
        fetchedAt: result.at,
        via: 'fetch',
        note: result.ok ? null : '抓取失败：' + result.content.slice(0, 200),
        verified: result.ok && Boolean(target),
        status: result.ok ? 'ok' : 'failed',
      })
      continue
    }

    if (/search/i.test(call.name)) {
      const hits = urlsIn(result.content ?? '')
      for (const url of hits.slice(0, 10)) {
        push({
          title: titleFromUrl(url),
          url,
          fetchedAt: result.at,
          via: 'search',
          note: '搜索结果；正文未抓取',
          verified: true,
          status: 'ok',
        })
      }
    }
  }

  return sources
}

/**
 * True when a reply only says what it is about to do.
 *
 * "I'll research this now" is not a report. Detecting it lets the executor ask for the
 * actual prose instead of saving a report whose body is a promise.
 */
export function isAnnouncementOnly(reply: string): boolean {
  const text = reply.trim()
  if (text.length === 0) return true
  // Already a structured report: nothing to ask for.
  if (/##\s*已验证事实/.test(text)) return false
  // An intent statement, however long: it announces the work instead of doing it.
  if (/^(I'll|I will|Let me|I'm going to|我先|我会|让我|好的[，,]?我)/i.test(text)) return true
  // A short reply with no structure is a preamble, not a report.
  return text.length < 200 && !/\n\s*[-*\d]/.test(text)
}

/**
 * Put the model's prose into the five sections a report must have.
 *
 * If the model already wrote the headings, its text is used as-is. If it wrote prose, the
 * prose goes under 已验证事实 when there is a verified source and under 未验证信息 when there
 * is not, and the remaining sections say plainly that they were not addressed.
 */
export function assembleReport(reply: string, sources: ResearchSource[], question: string): string {
  // A structured report from the model is used as written.
  if (/##\s*已验证事实/.test(reply)) return reply

  const verified = sources.filter((source) => source.verified)
  const fetched = verified.filter((source) => source.via === 'fetch')
  const searched = verified.filter((source) => source.via === 'search')

  const sourceLines = verified.length > 0
    ? verified.slice(0, 12).map((source) => '- [' + source.title + '](' + source.url + ') — ' + source.via + '，' + source.fetchedAt).join('\n')
    : '（本次没有获得可验证的外部来源）'

  // The model's own words are kept when they say something; a bare announcement is not
  // evidence and is dropped rather than dressed up as a finding.
  const prose = isAnnouncementOnly(reply) ? '' : reply.trim()

  return [
    '## 已验证事实',
    '',
    '本次检索围绕：' + question,
    '',
    '工具实际返回的来源（' + verified.length + ' 条，其中抓取正文 ' + fetched.length + ' 条、搜索结果 ' + searched.length + ' 条）：',
    '',
    sourceLines,
    '',
    prose ? '模型对以上来源的归纳：' : '',
    prose,
    '',
    '## 未验证信息',
    '',
    '以上来源的正文只做了检索层面的确认；没有逐条核对原文细节，因此具体数值与机制描述仍需人工复核。',
    '',
    '## 合理推测',
    '',
    '（本次没有单独产出推测内容。推测需要基于已核实的原文，而本次只完成了检索。）',
    '',
    '## AI 建议',
    '',
    '（本次没有单独产出设计建议。建议应在核实原文之后给出。）',
    '',
    '## 需要用户决定',
    '',
    '- 是否需要针对上述来源做逐条原文核对。',
    '- 是否要把其中某几条来源作为正式需求基线的依据。',
  ].filter((line) => line !== '').join('\n')
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname
    return decodeURIComponent(last).replace(/[-_]+/g, ' ').slice(0, 80) || parsed.hostname
  } catch {
    return url.slice(0, 80)
  }
}

export class ResearchExecutor {
  readonly #options: ResearchExecutorOptions
  readonly #timeout: number

  constructor(options: ResearchExecutorOptions) {
    this.#options = options
    this.#timeout = options.timeoutMs ?? DEFAULT_TIMEOUT
  }

  /**
   * Run one research request.
   *
   * Two turns, two leases, two sessions. The first gathers; the second writes from what the
   * first actually returned.
   */
  async run(input: { projectId: string; question: string; scope: string | null }): Promise<ResearchRunResult> {
    // A turn occasionally ends with tool calls but no text. That is not a research failure —
    // it is a turn that produced nothing to read, so it is retried once on a fresh lease
    // before the request is reported as failed.
    const first = await this.#attempt(input)
    if (first.ok || first.markdown.trim().length > 0) return first
    this.#options.logger.warn('research.retry', { projectId: input.projectId, reason: first.error })
    const second = await this.#attempt(input)
    if (second.ok) return second
    return first.error === '模型没有返回报告正文。' ? second : second
  }

  async #attempt(input: { projectId: string; question: string; scope: string | null }): Promise<ResearchRunResult> {
    const project = this.#options.projectContext(input.projectId)

    const collected = await this.#turn({
      projectId: input.projectId,
      label: 'research',
      prompt: [
        '你是游戏设计研究员。请完成一次研究。',
        '',
        '重要：检索和写报告必须在同一次回复里完成。不要先说「我先检索」然后停下——',
        '调用工具之后，继续在同一个回合里把完整报告写出来。',
        '',
        '工具预算（硬性）：最多调用 2 次 web_search、最多 2 次 web_fetch。用完就写报告。',
        '',
        '报告格式（硬性）：必须分成五个小节，标题逐字使用：',
        '## 已验证事实',
        '## 未验证信息',
        '## 合理推测',
        '## AI 建议',
        '## 需要用户决定',
        '',
        '规则：',
        '1. 「已验证事实」只写你从工具结果里实际读到的内容，并附上来源 URL。',
        '2. 工具没有覆盖到的内容放进「未验证信息」，不要编造链接。',
        '3. 不要写任何形如 https:// 的链接，除非它出现在你的工具结果里。',
        '4. 不要修改任何文件，不要执行命令。',
        '',
        '项目：' + project.name + '（' + project.engine + ' / ' + project.platform + '）',
        project.facts.length > 0 ? '已知事实：' + project.facts.join('；') : '',
        '研究问题：' + input.question,
        input.scope ? '范围：' + input.scope : '',
      ].filter(Boolean).join('\n'),
    })

    const sources = sourcesFromToolTraffic(collected.calls, collected.results)
    const verified = sources.filter((source) => source.verified)

    if (collected.error) {
      return { ok: false, markdown: collected.reply, sources, error: collected.error, toolCalls: collected.calls, hasVerifiedSources: verified.length > 0 }
    }

    // A research run is only worth saving when it actually gathered something. A model that
    // answered from memory without calling a tool produced no evidence, and calling that a
    // completed research report would be the fabrication this whole file guards against.
    if (collected.calls.length === 0) {
      return {
        ok: false,
        markdown: collected.reply,
        sources,
        error: '模型没有调用任何检索工具，本次研究没有可验证来源。',
        toolCalls: collected.calls,
        hasVerifiedSources: false,
      }
    }

    const markdown = assembleReport(collected.reply, sources, input.question)

    this.#options.logger.info('research.executed', {
      projectId: input.projectId,
      toolCalls: collected.calls.length,
      sources: sources.length,
      verified: verified.length,
      modelWroteReport: /##\s*已验证事实/.test(collected.reply),
    })
    return { ok: true, markdown, sources, error: null, toolCalls: collected.calls, hasVerifiedSources: verified.length > 0 }
  }

  /** One turn on its own lease and its own session. */
  async #turn(input: { projectId: string; label: string; prompt: string }): Promise<Collected & { error: string | null }> {
    const collected: Collected = { reply: '', calls: [], results: [] }
    const sessionId = 'research-' + input.label + '-' + crypto.randomUUID().slice(0, 8)
    let lease: RuntimeLease | null = null

    try {
      lease = await this.#options.supervisor.acquire({
        taskId: 'research:' + input.projectId + ':' + input.label,
        isolation: 'readonly',
        label: input.label,
      })
      lease.bindSession(sessionId)

      const stream = (lease.client.subscribeSessionTree?.(sessionId) ?? lease.client.subscribe?.()) as
        | { next(): Promise<unknown>; close(): void }
        | undefined
      if (!stream) throw new Error('运行时没有提供事件订阅')

      const drain = this.#drain(stream, collected)
      const messageId = await lease.client.prompt(sessionId, [{ type: 'text', text: input.prompt }] as never)
      this.#options.logger.info('research.turn.prompted', { label: input.label, sessionId, messageId })
      const outcome = await drain
      this.#options.logger.info('research.turn.drained', { label: input.label, replyLength: collected.reply.length, calls: collected.calls.length, error: outcome.error })
      return { ...collected, error: outcome.error }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.#options.logger.error('research.turn.failed', { projectId: input.projectId, label: input.label, error: message })
      return { ...collected, error: message }
    } finally {
      if (lease) {
        try {
          await lease.release('research-turn-finished')
        } catch {
          /* the supervisor reports its own close failures */
        }
      }
    }
  }

  async #drain(
    subscription: { next(): Promise<unknown>; close(): void },
    collected: Collected,
  ): Promise<{ error: string | null }> {
    const deadline = Date.now() + this.#timeout
    let sawWork = false
    try {
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return { error: sawWork ? null : '研究没有在限额内开始回应。' }
        const next = await Promise.race([
          subscription.next(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(remaining, 15000))),
        ])
        if (next === null) continue
        const notification = next as { method?: string; params?: Record<string, unknown> }
        if (notification?.method !== 'session.event') continue
        const event = notification.params?.event as Record<string, unknown> | undefined
        const payload = (event?.data ?? event) as Record<string, unknown> | undefined
        const type = String(event?.type ?? '')
        if (type === 'step/start') sawWork = true

        if (type === 'assistant/message') {
          for (const block of (payload?.message as { content?: Record<string, unknown>[] } | undefined)?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') collected.reply += block.text
          }
        }
        if (type === 'tool/call') {
          collected.calls.push({ name: String(payload?.name ?? ''), arguments: String(payload?.arguments ?? '') })
        }
        if (type === 'tool/result') {
          const message = payload?.message as { content?: Record<string, unknown>[]; isError?: boolean } | undefined
          const text = (message?.content ?? [])
            .map((block) => (typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : ''))
            .join('\n')
          collected.results.push({
            name: collected.calls[collected.calls.length - 1]?.name ?? '',
            content: text,
            ok: message?.isError !== true && text.trim().length > 0,
            at: new Date().toISOString(),
          })
        }
        if (type === 'turn/end' && sawWork) return { error: null }
      }
    } catch (error) {
      return { error: String((error as Error)?.message ?? error) }
    } finally {
      try {
        subscription.close()
      } catch {
        /* already closed */
      }
    }
  }
}
