/**
 * Context compilation for an advisor turn.
 *
 * The failure this file exists to prevent: stuffing the whole conversation into every
 * prompt. That works until it does not, and then it fails silently — the model starts
 * ignoring the middle of a long context and the user cannot tell why.
 *
 * So the compiler has a budget, spends it in priority order, and records what it spent it
 * on. The record is not decoration: it is how a user can see that their project rules were
 * included and their oldest chat messages were not.
 */
import type { AttachmentRecord, ContextPurpose, ContextSource, DraftRecord, MessageRecord } from './types'

export interface ContextInput {
  project: { id: string; name: string; engine: string; platform: string }
  /** The user's message for this turn. Never truncated. */
  userMessage: string
  /** Project rules, already read through the rules service. */
  rules: { title: string; content: string }[]
  /** Facts the user has confirmed. */
  facts: string[]
  /** Questions still open. */
  openQuestions: string[]
  /** Drafts that exist for this project. */
  drafts: DraftRecord[]
  /** Recent conversation history, oldest first. */
  history: MessageRecord[]
  /** Attachments referenced in this turn. */
  attachments: AttachmentRecord[]
  /** What this turn is for; affects which sections are worth spending on. */
  purpose: ContextPurpose
}

export interface CompiledContext {
  /** The text handed to the DSH session. */
  text: string
  /** What went in, for the snapshot record. */
  sources: ContextSource[]
  /** Characters used. */
  size: number
  /** True when something was dropped to fit the budget. */
  truncated: boolean
}

/** Total characters allowed. Roughly 8k tokens of Chinese text, leaving room for the reply. */
export const DEFAULT_BUDGET = 24000

/** Per-section caps, so one large attachment cannot crowd out everything else. */
const SECTION_CAPS = {
  rules: 4000,
  facts: 2000,
  openQuestions: 1500,
  drafts: 3000,
  history: 6000,
  attachments: 5000,
}

const clip = (text: string, max: number): { text: string; truncated: boolean } => {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '\n…（已截断）', truncated: true }
}

export class ContextCompiler {
  readonly #budget: number

  constructor(budget = DEFAULT_BUDGET) {
    this.#budget = budget
  }

  get budget(): number {
    return this.#budget
  }

  /**
   * Build the context for one turn.
   *
   * Order is deliberate: the user's message and the project identity always fit, then rules,
   * then confirmed facts, then open questions, then drafts, then recent history, then
   * attachments. History is spent last because it is the most compressible: the user's own
   * words matter more than a transcript of what was already said.
   */
  compile(input: ContextInput): CompiledContext {
    const sources: ContextSource[] = []
    const parts: string[] = []
    let used = 0
    let truncated = false

    /**
     * Add a section, clipped to fit.
     *
     * `prebuilt` sections are already trimmed by their own logic and must go in whole: the
     * history loop keeps the newest messages, and clipping the result from the end would cut
     * off exactly those. For those, a section that does not fit is dropped rather than cut.
     */
    const spend = (
      kind: ContextSource['kind'],
      label: string,
      body: string,
      cap: number,
      ref: string | null = null,
      prebuilt = false,
    ): boolean => {
      const room = Math.min(cap, this.#budget - used)
      if (room <= 0) {
        truncated = true
        return false
      }
      if (prebuilt && body.length > room) {
        truncated = true
        return false
      }
      const clipped = prebuilt ? { text: body, truncated: false } : clip(body, room)
      if (clipped.truncated) truncated = true
      parts.push(clipped.text)
      used += clipped.text.length
      sources.push({ kind, label, size: clipped.text.length, ref })
      return true
    }

    // Identity and the current ask: never dropped. The role statement comes first because
    // the runtime is a coding agent by default: without it, a question about a game gets
    // answered by someone trying to fix the repository.
    const header = [
      '你是一名游戏设计顾问，正在帮助用户把一个想法逐步变成可执行的需求。',
      '规则：',
      '1. 每次只追问最关键的一到两个问题，不要一次抛出长表单。',
      '2. 不要修改任何文件，不要执行命令，不要分析仓库。你只负责讨论。',
      '3. 已确认的信息不要重复询问；用户没有确认的内容不要当成已确认。',
      '4. 明确区分「用户说的」「你的推测」「你的建议」。',
      '5. 回复用中文，简洁，一次推进一小步。',
      '',
      '# 项目',
      '名称：' + input.project.name,
      '引擎：' + input.project.engine,
      '目标平台：' + input.project.platform,
      '',
      '# 用户本轮输入',
      input.userMessage,
    ].join('\n')
    parts.push(header)
    used += header.length
    sources.push({ kind: 'project', label: '项目信息与用户输入', size: header.length, ref: input.project.id })

    if (input.rules.length > 0) {
      const body = ['# 项目规则', ...input.rules.map((r) => '## ' + r.title + '\n' + r.content)].join('\n')
      spend('rule', '项目规则', body, SECTION_CAPS.rules)
    }

    if (input.facts.length > 0) {
      const body = ['# 已确认事实', ...input.facts.map((f) => '- ' + f)].join('\n')
      spend('fact', '已确认事实', body, SECTION_CAPS.facts)
    }

    if (input.openQuestions.length > 0) {
      const body = ['# 待确认问题', ...input.openQuestions.map((f) => '- ' + f)].join('\n')
      spend('open-question', '待确认问题', body, SECTION_CAPS.openQuestions)
    }

    if (input.drafts.length > 0) {
      const body = ['# 现有草稿', ...input.drafts.map((d) => '- [' + d.kind + '] ' + d.title + '（v' + d.currentVersion + '，' + d.status + '）')].join('\n')
      spend('draft', '现有草稿', body, SECTION_CAPS.drafts)
    }

    if (input.history.length > 0) {
      // Walk backwards so the newest exchange is kept, then restore chronological order.
      // The bound is the real remaining budget, not just the section cap: spend() clips from
      // the end, which would cut off exactly the newest message this loop is protecting.
      // The heading is reserved up front so the section fits as a whole.
      const heading = '# 最近对话'
      const room = Math.min(SECTION_CAPS.history, this.#budget - used) - heading.length - 1
      const kept: string[] = []
      let spent = 0
      for (let i = input.history.length - 1; i >= 0 && room > 0; i -= 1) {
        const message = input.history[i]
        const line = (message.role === 'user' ? '用户：' : '顾问：') + message.content
        if (spent + line.length + 1 > room) {
          truncated = true
          break
        }
        kept.unshift(line)
        spent += line.length + 1
      }
      if (kept.length > 0) spend('history', '最近对话', [heading, ...kept].join('\n'), SECTION_CAPS.history, null, true)
    }

    if (input.attachments.length > 0) {
      const lines: string[] = ['# 附件']
      for (const attachment of input.attachments) {
        if (attachment.extractedText) {
          lines.push('## ' + attachment.filename + '\n' + attachment.extractedText)
        } else {
          lines.push('## ' + attachment.filename + '（' + attachment.kind + '，' + attachment.bytes + ' 字节）')
        }
      }
      spend('attachment', '附件', lines.join('\n'), SECTION_CAPS.attachments, input.attachments.map((a) => a.id).join(','))
    }

    const text = parts.join('\n\n')
    return { text, sources, size: text.length, truncated }
  }
}
