/**
 * Requirement baselines: the one thing in this app that cannot be undone.
 *
 * Everything else a user does is reversible. Freezing a baseline is not, so the rules are
 * narrow and enforced in three places: this service refuses, the store refuses, and the
 * database trigger refuses. A UI that hides an edit button is not one of them.
 */
import type { RequirementStore } from './store'
import type { BaselineRecord, ChangeImpact, ChangeProposalRecord, DraftRecord } from './types'

export interface BaselineSection {
  id: string
  title: string
  /** Markdown body. */
  body: string
  /** True when the user has confirmed this section; false when it is still a proposal. */
  confirmed: boolean
}

export interface BaselineContent {
  name: string
  summary: string
  sections: BaselineSection[]
  scope: string[]
  outOfScope: string[]
  openQuestions: string[]
  risks: string[]
  milestones: string[]
  acceptance: string[]
  sources: { kind: string; label: string; ref: string | null }[]
}

export interface BaselinePreview {
  /** The content that would be frozen, exactly as it would be stored. */
  content: string
  /** Sections still marked unconfirmed; the UI must show these before freezing. */
  unconfirmed: string[]
  /** Open questions that would be frozen as-is. */
  openQuestions: string[]
  /** What freezing would do, in the user's words. */
  consequences: string[]
  /** Differences from the previous baseline, when there is one. */
  diff: { added: string[]; removed: string[]; changed: string[] } | null
}

export class BaselineService {
  readonly #store: RequirementStore

  constructor(store: RequirementStore) {
    this.#store = store
  }

  /** Build the preview a user must see before freezing. Nothing is written. */
  preview(projectId: string, content: BaselineContent): BaselinePreview {
    const serialised = JSON.stringify(content, null, 2)
    const unconfirmed = content.sections.filter((section) => !section.confirmed).map((section) => section.title)
    const previous = this.#store.latestBaseline(projectId)

    const consequences = [
      '冻结后会生成一个正式需求版本，内容不可再修改。',
      '后续任何修改都必须通过变更提案，并生成新的版本。',
      '开发任务只能依据冻结后的基线创建。',
    ]
    if (unconfirmed.length > 0) {
      consequences.push('仍有 ' + unconfirmed.length + ' 个章节未标记为已确认，冻结后它们会作为正式需求的一部分。')
    }
    if (content.openQuestions.length > 0) {
      consequences.push('仍有 ' + content.openQuestions.length + ' 个未决问题会一并冻结。')
    }

    return {
      content: serialised,
      unconfirmed,
      openQuestions: [...content.openQuestions],
      consequences,
      diff: previous ? this.#diff(previous.content, serialised) : null,
    }
  }

  /**
   * Freeze a baseline.
   *
   * Refused when the user has not confirmed: the caller must pass the confirmation
   * explicitly, so a code path that forgets cannot freeze by accident.
   */
  freeze(input: {
    projectId: string
    content: BaselineContent
    confirmedBy: string
    sourceDraftId?: string | null
  }): BaselineRecord {
    if (!input.confirmedBy || input.confirmedBy.trim().length === 0) {
      throw new Error('BASELINE_NOT_CONFIRMED: 冻结必须由用户明确确认。')
    }
    const serialised = JSON.stringify(input.content, null, 2)
    return this.#store.freezeBaseline({
      projectId: input.projectId,
      name: input.content.name,
      content: serialised,
      confirmedBy: input.confirmedBy,
      sourceDraftId: input.sourceDraftId ?? null,
    })
  }

  latest(projectId: string): BaselineRecord | null {
    return this.#store.latestBaseline(projectId)
  }

  list(projectId: string): BaselineRecord[] {
    return this.#store.listBaselines(projectId)
  }

  get(projectId: string, baselineId: string): BaselineRecord | null {
    return this.#store.getBaseline(projectId, baselineId)
  }

  /** Compare two stored versions. Both must belong to the project. */
  compare(projectId: string, leftId: string, rightId: string): { added: string[]; removed: string[]; changed: string[] } | null {
    const left = this.#store.getBaseline(projectId, leftId)
    const right = this.#store.getBaseline(projectId, rightId)
    if (!left || !right) return null
    return this.#diff(left.content, right.content)
  }

  /** Section-level differences between two serialised baselines. */
  #diff(before: string, after: string): { added: string[]; removed: string[]; changed: string[] } {
    const parse = (text: string): BaselineContent | null => {
      try {
        return JSON.parse(text) as BaselineContent
      } catch {
        return null
      }
    }
    const a = parse(before)
    const b = parse(after)
    if (!a || !b) return { added: [], removed: [], changed: [] }

    const mapA = new Map(a.sections.map((s) => [s.title, s.body]))
    const mapB = new Map(b.sections.map((s) => [s.title, s.body]))
    const added = [...mapB.keys()].filter((k) => !mapA.has(k))
    const removed = [...mapA.keys()].filter((k) => !mapB.has(k))
    const changed = [...mapB.keys()].filter((k) => mapA.has(k) && mapA.get(k) !== mapB.get(k))
    return { added, removed, changed }
  }

  // ------------------------------------------------------------------ change proposals

  /**
   * Propose a change to a frozen baseline.
   *
   * The proposal records what the user asked for and, separately, what the analysis could
   * and could not determine. An analysis that claims completeness it does not have is worse
   * than one that lists its gaps.
   */
  proposeChange(input: {
    projectId: string
    baselineId: string
    title: string
    description: string
    drafts?: DraftRecord[]
  }): ChangeProposalRecord {
    const baseline = this.#store.getBaseline(input.projectId, input.baselineId)
    if (!baseline) throw new Error('unknown baseline: ' + input.baselineId)

    const impact = this.#analyse(baseline.content, input.description, input.drafts ?? [])
    return this.#store.createProposal({
      projectId: input.projectId,
      baselineId: input.baselineId,
      title: input.title,
      description: input.description,
      impact,
    })
  }

  /**
   * A deterministic first-pass impact analysis.
   *
   * It matches the change text against baseline section titles and draft titles. That is a
   * keyword match, not an understanding of the change, and the result says so in
   * notAnalyzed rather than implying the analysis is complete.
   */
  #analyse(baselineContent: string, description: string, drafts: DraftRecord[]): ChangeImpact {
    let parsed: BaselineContent | null = null
    try {
      parsed = JSON.parse(baselineContent) as BaselineContent
    } catch {
      parsed = null
    }
    const sections = parsed?.sections ?? []
    // Chinese has no spaces, so splitting the change text into words and asking whether a
    // section title contains one of them finds nothing. The useful direction is the other
    // way round: does the change text mention this section's title, or a distinctive part
    // of its body?
    const haystack = description.toLowerCase()
    const mentions = (needle: string): boolean => {
      const trimmed = needle.trim().toLowerCase()
      if (trimmed.length < 2) return false
      if (haystack.includes(trimmed)) return true
      // Also try the longest 2-4 character run of the title, which catches "核心玩法" in
      // "把核心玩法改成 Boss 战" even when the surrounding words differ.
      for (let size = Math.min(4, trimmed.length); size >= 2; size -= 1) {
        for (let start = 0; start + size <= trimmed.length; start += 1) {
          if (haystack.includes(trimmed.slice(start, start + size))) return true
        }
      }
      return false
    }

    const touched = sections
      .filter((section) => mentions(section.title) || mentions(section.body))
      .map((section) => section.title)

    const affectedDrafts = drafts.filter((draft) => mentions(draft.title)).map((draft) => draft.title)

    return {
      sections: touched,
      drafts: affectedDrafts,
      rework: touched.map((title) => '需要重新确认章节：' + title),
      risks: touched.length === 0 ? ['未能定位受影响的章节，变更范围可能比预期更大。'] : ['受影响章节的验收标准需要重新检查。'],
      notAnalyzed: [
        '未评估开发工作量与排期影响。',
        '未评估对已完成代码的影响。',
        '未评估对美术与音频资源的影响。',
        '影响分析基于关键词匹配，不是对变更语义的理解。',
      ],
    }
  }

  decide(input: {
    projectId: string
    proposalId: string
    status: 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION'
    decidedBy: string
    note?: string | null
  }): ChangeProposalRecord {
    if (!input.decidedBy || input.decidedBy.trim().length === 0) {
      throw new Error('PROPOSAL_NOT_DECIDED: 审批必须由用户明确操作。')
    }
    return this.#store.decideProposal(input)
  }

  listProposals(projectId: string): ChangeProposalRecord[] {
    return this.#store.listProposals(projectId)
  }

  getProposal(projectId: string, proposalId: string): ChangeProposalRecord | null {
    return this.#store.getProposal(projectId, proposalId)
  }
}
