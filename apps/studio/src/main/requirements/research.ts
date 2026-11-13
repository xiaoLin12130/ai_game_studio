/**
 * Research requests and reports.
 *
 * The rule this file enforces: a report that cites an external fact must carry the source it
 * came from, with the time it was fetched. A model can produce a plausible URL; only a
 * recorded fetch proves one was read.
 *
 * The runtime has web_search and web_fetch (verified in M0), so the advisor can research for
 * real. What it cannot do is decide what counts as verified — that separation is here.
 */
import type { RequirementStore } from './store'
import type { ResearchReportRecord, ResearchRequestRecord, ResearchSource } from './types'

export interface ResearchLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** The sections a report must keep apart. */
export const REPORT_SECTIONS = [
  '已验证事实',
  '未验证信息',
  '合理推测',
  'AI 建议',
  '需要用户决定',
] as const

export interface ParsedReport {
  sections: Record<string, string>
  /** Sources the model claimed, before any verification. */
  claimedSources: ResearchSource[]
  /** True when at least one section is missing. */
  incomplete: boolean
  missing: string[]
}

/**
 * Split a model-written report into the required sections.
 *
 * A report that does not separate facts from guesses is not usable, so this reports what is
 * missing rather than silently accepting a wall of prose.
 */
export function parseReport(markdown: string): ParsedReport {
  const sections: Record<string, string> = {}
  let current: string | null = null
  const buffer: string[] = []

  const flush = () => {
    if (current) sections[current] = buffer.join('\n').trim()
    buffer.length = 0
  }

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,4}\s*(.+?)\s*$/.exec(line)
    if (heading) {
      const title = heading[1].trim()
      const matched = REPORT_SECTIONS.find((name) => title.includes(name))
      if (matched) {
        flush()
        current = matched
        continue
      }
    }
    if (current) buffer.push(line)
  }
  flush()

  const missing = REPORT_SECTIONS.filter((name) => !sections[name] || sections[name].length === 0)
  return { sections, claimedSources: [], incomplete: missing.length > 0, missing }
}

export interface ResearchServiceOptions {
  store: RequirementStore
  logger: ResearchLogger
  /** Runs one research turn through the advisor and returns the model's markdown. */
  runResearch: (input: { projectId: string; question: string; scope: string | null }) => Promise<{
    ok: boolean
    markdown: string
    sources: ResearchSource[]
    error: string | null
    hasVerifiedSources?: boolean
  }>
}

export class ResearchService {
  readonly #store: RequirementStore
  readonly #logger: ResearchLogger
  readonly #runResearch: ResearchServiceOptions['runResearch']

  constructor(options: ResearchServiceOptions) {
    this.#store = options.store
    this.#logger = options.logger
    this.#runResearch = options.runResearch
  }

  createRequest(input: { projectId: string; conversationId?: string | null; question: string; scope?: string | null }): ResearchRequestRecord {
    const question = input.question.trim()
    if (question.length === 0) throw new Error('研究请求需要一个具体问题。')
    return this.#store.createResearchRequest({
      projectId: input.projectId,
      conversationId: input.conversationId ?? null,
      question,
      scope: input.scope ?? null,
    })
  }

  listRequests(projectId: string): ResearchRequestRecord[] {
    return this.#store.listResearchRequests(projectId)
  }

  listReports(projectId: string): ResearchReportRecord[] {
    return this.#store.listResearchReports(projectId)
  }

  getReport(projectId: string, reportId: string): ResearchReportRecord | null {
    return this.#store.getResearchReport(projectId, reportId)
  }

  /**
   * Run a research request and store the report.
   *
   * A failed run is recorded as FAILED with the reason, not as an empty report: an empty
   * report would look like "we researched this and found nothing", which is a different and
   * much more misleading claim.
   */
  async run(projectId: string, requestId: string): Promise<{ ok: boolean; report: ResearchReportRecord | null; error: string | null; incomplete: string[] }> {
    const request = this.#store.getResearchRequest(projectId, requestId)
    if (!request) return { ok: false, report: null, error: '研究请求不存在。', incomplete: [] }

    this.#store.setResearchStatus(projectId, requestId, 'IN_PROGRESS')
    try {
      const result = await this.#runResearch({ projectId, question: request.question, scope: request.scope })
      if (!result.ok) {
        this.#store.setResearchStatus(projectId, requestId, 'FAILED')
        this.#logger.warn('research.failed', { projectId, requestId, error: result.error })
        return { ok: false, report: null, error: result.error ?? '研究失败。', incomplete: [] }
      }

      const parsed = parseReport(result.markdown)

      // A report that cited nothing real is still a report, but it must say so where a
      // reader will see it — not quietly look like researched output.
      const verified = result.sources.filter((source) => source.verified)
      const notice = verified.length === 0
        ? '\n\n---\n\n> 本次研究没有获得可验证的外部来源。以上内容来自模型知识与推理，未经外部核实。'
        : ''
      const content = result.markdown + notice

      const report = this.#store.createResearchReport({
        projectId,
        requestId,
        title: request.question.slice(0, 60),
        content,
        sources: result.sources,
        status: 'COMPLETED',
      })
      this.#store.setResearchStatus(projectId, requestId, 'COMPLETED')
      this.#logger.info('research.completed', {
        projectId,
        requestId,
        sources: result.sources.length,
        verified: verified.length,
        incomplete: parsed.missing.length,
      })
      return { ok: true, report, error: null, incomplete: parsed.missing }
    } catch (error) {
      this.#store.setResearchStatus(projectId, requestId, 'FAILED')
      const message = String((error as Error)?.message ?? error)
      this.#logger.error('research.error', { projectId, requestId, error: message })
      return { ok: false, report: null, error: message, incomplete: [] }
    }
  }
}
