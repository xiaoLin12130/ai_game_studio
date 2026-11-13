/**
 * The requirement system's UI.
 *
 * Kept out of renderer.ts because it is a different job: renderer.ts draws the runtime and
 * task panels, this draws the conversation, the drafts and the freeze flow. Both are plain
 * DOM; neither reaches for the filesystem or the SDK.
 */

type ReqConversation = { id: string; projectId: string; title: string; status: string; updatedAt: string; lastMessageAt: string | null }
type ReqMessage = { id: string; conversationId: string; role: string; kind: string; content: string; seq: number; createdAt: string }
type ReqDraft = { id: string; projectId: string; kind: string; title: string; status: string; currentVersion: number; updatedAt: string }
type ReqDraftVersion = { id: string; draftId: string; version: number; content: string; note: string | null; createdAt: string }
type ReqBaseline = { id: string; projectId: string; version: number; name: string; content: string; contentHash: string; status: string; frozenAt: string; confirmedBy: string; previousBaselineId: string | null }
type ReqProposal = { id: string; baselineId: string; title: string; description: string; status: string; impact: { sections: string[]; drafts: string[]; rework: string[]; risks: string[]; notAnalyzed: string[] } | null; createdAt: string }
type ReqCandidate = { id: string; proposalId: string; baselineId: string; content: string; contentHash: string; createdAt: string; frozenBaselineId: string | null }
type ReqReport = { id: string; title: string; content: string; sources: { title: string; url: string; fetchedAt: string; via: string }[]; createdAt: string }
type ReqAttachment = { id: string; filename: string; kind: string; bytes: number }

interface RequirementsApi {
  listConversations(projectId: string): Promise<ReqConversation[]>
  createConversation(projectId: string, title: string): Promise<ReqConversation>
  listMessages(projectId: string, conversationId: string): Promise<ReqMessage[]>
  sendMessage(projectId: string, conversationId: string, text: string, attachmentIds?: string[]): Promise<{ ok: boolean; reply: string; error: string | null; timedOut: boolean }>
  attachFile(projectId: string, conversationId: string | null, filename: string, mime: string, base64: string): Promise<{ ok: boolean; attachment?: ReqAttachment; code?: string; detail?: string }>
  listAttachments(projectId: string, conversationId?: string | null): Promise<ReqAttachment[]>
  removeAttachment(projectId: string, attachmentId: string): Promise<boolean>
  listDrafts(projectId: string, kind?: string): Promise<ReqDraft[]>
  createDraft(projectId: string, kind: string, title: string, content: string): Promise<ReqDraft>
  getDraft(projectId: string, draftId: string): Promise<{ draft: ReqDraft; versions: ReqDraftVersion[] } | null>
  addDraftVersion(projectId: string, draftId: string, content: string, note?: string): Promise<ReqDraftVersion>
  setDraftStatus(projectId: string, draftId: string, status: string): Promise<ReqDraft>
  listResearch(projectId: string): Promise<{ id: string; question: string; status: string }[]>
  listReports(projectId: string): Promise<ReqReport[]>
  createResearch(projectId: string, question: string, scope?: string | null): Promise<{ id: string; question: string; status: string }>
  runResearch(projectId: string, requestId: string): Promise<{ ok: boolean; report: ReqReport | null; error: string | null; incomplete: string[] }>
  previewBaseline(projectId: string, content: unknown): Promise<{ content: string; unconfirmed: string[]; openQuestions: string[]; consequences: string[]; diff: { added: string[]; removed: string[]; changed: string[] } | null }>
  freezeBaseline(projectId: string, content: unknown, confirmedBy: string, sourceDraftId?: string | null): Promise<ReqBaseline>
  listBaselines(projectId: string): Promise<ReqBaseline[]>
  getBaseline(projectId: string, baselineId: string): Promise<ReqBaseline | null>
  compareBaselines(projectId: string, leftId: string, rightId: string): Promise<{ added: string[]; removed: string[]; changed: string[] } | null>
  listProposals(projectId: string): Promise<ReqProposal[]>
  listCandidates(projectId: string): Promise<ReqCandidate[]>
  createCandidate(projectId: string, proposalId: string): Promise<ReqCandidate>
  candidateDiff(projectId: string, candidateId: string): Promise<{ added: string[]; removed: string[]; changed: string[] } | null>
  freezeCandidate(projectId: string, candidateId: string, confirmedBy: string): Promise<ReqBaseline>
  createProposal(projectId: string, baselineId: string, title: string, description: string): Promise<ReqProposal>
  decideProposal(projectId: string, proposalId: string, status: string, decidedBy: string, note?: string | null): Promise<ReqProposal>
}

interface RequirementsUiDeps {
  api: RequirementsApi
  byId(id: string): HTMLElement
  setText(id: string, text: string): void
  describeError(error: unknown): string
  formatWhen(iso: string): string
  /** The project currently open, or null. */
  currentProjectId(): string | null
  /** Called after a change that other panels should see. */
  onChanged(): void
}

const ROLE_LABEL: Record<string, string> = { user: '你', assistant: '顾问', tool: '工具', system: '系统' }

/**
 * Render the small markdown subset a model actually uses in conversation.
 *
 * Bold, inline code, bullet and numbered lists, and headings. Everything is created as a
 * text node or an element with textContent, so nothing the model writes can become markup.
 */
function renderMarkdown(target: HTMLElement, source: string): void {
  const inline = (text: string): DocumentFragment => {
    const fragment = document.createDocumentFragment()
    const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) fragment.append(document.createTextNode(text.slice(last, match.index)))
      if (match[1] !== undefined) {
        const strong = document.createElement('strong')
        strong.textContent = match[1]
        fragment.append(strong)
      } else {
        const code = document.createElement('code')
        code.textContent = match[2]
        fragment.append(code)
      }
      last = match.index + match[0].length
    }
    if (last < text.length) fragment.append(document.createTextNode(text.slice(last)))
    return fragment
  }

  let list: HTMLElement | null = null
  let listKind: 'ul' | 'ol' | null = null

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)

    if (bullet || numbered) {
      const kind: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      if (!list || listKind !== kind) {
        list = document.createElement(kind)
        listKind = kind
        target.append(list)
      }
      const item = document.createElement('li')
      item.append(inline((bullet ?? numbered)![1]))
      list.append(item)
      continue
    }

    list = null
    listKind = null

    if (heading) {
      const level = Math.min(4, heading[1].length + 2)
      const element = document.createElement('h' + level)
      element.append(inline(heading[2]))
      target.append(element)
      continue
    }

    if (line.trim().length === 0) {
      target.append(document.createElement('br'))
      continue
    }

    const paragraph = document.createElement('p')
    paragraph.append(inline(line))
    target.append(paragraph)
  }
}
const DRAFT_KIND_LABEL: Record<string, string> = { idea: '想法', design: '设计', gdd: 'GDD' }
const PROPOSAL_LABEL: Record<string, string> = { PENDING: '待审批', APPROVED: '已批准', REJECTED: '已拒绝', NEEDS_REVISION: '需修改' }

/**
 * What the user needs to know about a proposal, which is more than its own status.
 *
 * "Approved" and "waiting for you to confirm the new version" are different situations and
 * the screen has to say which one it is.
 */
function proposalStage(proposal: ReqProposal, candidates: ReqCandidate[]): { label: string; className: string; candidate: ReqCandidate | null } {
  const candidate = candidates.find((entry) => entry.proposalId === proposal.id) ?? null
  if (proposal.status === 'REJECTED') return { label: '已拒绝', className: 'rejected', candidate }
  if (proposal.status === 'NEEDS_REVISION') return { label: '需要修改', className: 'needs_revision', candidate }
  if (proposal.status === 'PENDING') return { label: '待审批', className: 'pending', candidate }
  if (candidate?.frozenBaselineId) return { label: '已冻结为新基线', className: 'approved', candidate }
  if (candidate) return { label: '候选版本待确认', className: 'pending', candidate }
  return { label: '已批准，尚未生成候选版本', className: 'approved', candidate }
}

class RequirementsUi {
  readonly #deps: RequirementsUiDeps
  #conversationId: string | null = null
  #draftId: string | null = null
  #pendingAttachments: string[] = []
  #candidates: ReqCandidate[] = []
  #previewContent: unknown = null

  constructor(deps: RequirementsUiDeps) {
    this.#deps = deps
  }

  // ------------------------------------------------------------------ advisor

  async refreshConversations(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const list = this.#deps.byId('conversation-list')
    list.replaceChildren()
    this.#deps.setText('advisor-project', projectId ? '当前项目已打开' : '未打开项目')

    if (!projectId) {
      const li = document.createElement('li')
      li.className = 'conversation-empty'
      li.textContent = '请先在「游戏项目」中打开一个项目。'
      list.append(li)
      this.#setComposerEnabled(false)
      return
    }
    this.#setComposerEnabled(true)

    const conversations = await this.#deps.api.listConversations(projectId)
    if (conversations.length === 0) {
      const li = document.createElement('li')
      li.className = 'conversation-empty'
      li.textContent = '还没有讨论。输入一句话就能开始。'
      list.append(li)
      return
    }
    for (const conversation of conversations) {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'conversation-row' + (conversation.id === this.#conversationId ? ' is-active' : '')
      button.textContent = conversation.title
      button.addEventListener('click', () => { void this.openConversation(conversation.id) })
      li.append(button)
      list.append(li)
    }
  }

  async openConversation(conversationId: string): Promise<void> {
    this.#conversationId = conversationId
    await this.refreshConversations()
    await this.refreshMessages()
  }

  async refreshMessages(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const list = this.#deps.byId('message-list')
    const empty = this.#deps.byId('advisor-empty')
    if (!projectId || !this.#conversationId) {
      list.hidden = true
      empty.hidden = false
      return
    }
    const messages = await this.#deps.api.listMessages(projectId, this.#conversationId)
    list.replaceChildren()
    if (messages.length === 0) {
      list.hidden = true
      empty.hidden = false
      return
    }
    empty.hidden = true
    list.hidden = false
    for (const message of messages) {
      list.append(this.#messageNode(message))
    }
    list.scrollTop = list.scrollHeight
  }

  /** Append the pending user message so the conversation responds immediately. */
  #showOptimisticUserMessage(text: string): void {
    const list = this.#deps.byId('message-list')
    const empty = this.#deps.byId('advisor-empty')
    empty.hidden = true
    list.hidden = false
    const node = this.#messageNode({
      id: 'pending',
      conversationId: this.#conversationId ?? '',
      role: 'user',
      kind: 'text',
      content: text,
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: new Date().toISOString(),
    })
    node.classList.add('message-pending')
    list.append(node)
    list.scrollTop = list.scrollHeight
  }

  #messageNode(message: ReqMessage): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'message message-' + message.role
    const head = document.createElement('div')
    head.className = 'message-head'
    const who = document.createElement('span')
    who.className = 'message-who'
    who.textContent = ROLE_LABEL[message.role] ?? message.role
    const when = document.createElement('span')
    when.className = 'message-when'
    when.textContent = this.#deps.formatWhen(message.createdAt)
    head.append(who, when)
    const body = document.createElement('div')
    body.className = 'message-body'
    if (message.role === 'assistant') {
      // The model writes markdown. Showing the asterisks makes a good answer look broken,
      // and innerHTML would let model output become markup, so this builds nodes.
      renderMarkdown(body, message.content)
    } else {
      body.textContent = message.content
    }
    wrap.append(head, body)
    return wrap
  }

  /** Send the composer's text. Creates a conversation on the first message. */
  async send(text: string): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('advisor-alert')
    alert.hidden = true
    if (!projectId) {
      alert.hidden = false
      alert.textContent = '请先打开一个项目。'
      return
    }
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    const sendButton = this.#deps.byId('composer-send') as HTMLButtonElement
    sendButton.disabled = true
    sendButton.textContent = '思考中…'
    this.#deps.setText('advisor-status', '顾问正在回应…')

    // Show the user's own words at once. A real turn can take minutes, and a composer that
    // appears to swallow the message for that long reads as broken.
    this.#showOptimisticUserMessage(trimmed)

    try {
      if (!this.#conversationId) {
        const conversation = await this.#deps.api.createConversation(projectId, trimmed.slice(0, 30))
        this.#conversationId = conversation.id
      }
      const result = await this.#deps.api.sendMessage(projectId, this.#conversationId, trimmed, this.#pendingAttachments)
      this.#pendingAttachments = []
      this.#renderPendingAttachments()
      if (!result.ok) {
        alert.hidden = false
        alert.textContent = result.error ?? '顾问没有回应。'
      }
      await this.refreshConversations()
      await this.refreshMessages()
      this.#deps.onChanged()
    } catch (error) {
      alert.hidden = false
      alert.textContent = '发送失败：' + this.#deps.describeError(error)
    } finally {
      sendButton.disabled = false
      sendButton.textContent = '发送'
      this.#deps.setText('advisor-status', '')
    }
  }

  /** Attach a file the user picked. */
  async attach(file: File): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('advisor-alert')
    alert.hidden = true
    if (!projectId) {
      alert.hidden = false
      alert.textContent = '请先打开一个项目。'
      return
    }
    const buffer = await file.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
    const result = await this.#deps.api.attachFile(projectId, this.#conversationId, file.name, file.type || 'application/octet-stream', base64)
    if (!result.ok) {
      alert.hidden = false
      alert.textContent = result.detail ?? '附件添加失败。'
      return
    }
    if (result.attachment) this.#pendingAttachments.push(result.attachment.id)
    this.#renderPendingAttachments()
  }

  #renderPendingAttachments(): void {
    const box = this.#deps.byId('composer-attachments')
    box.replaceChildren()
    for (const attachmentId of this.#pendingAttachments) {
      const chip = document.createElement('span')
      chip.className = 'attachment-chip'
      chip.textContent = attachmentId
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'attachment-remove'
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        this.#pendingAttachments = this.#pendingAttachments.filter((id) => id !== attachmentId)
        this.#renderPendingAttachments()
      })
      chip.append(remove)
      box.append(chip)
    }
  }

  #setComposerEnabled(enabled: boolean): void {
    const input = this.#deps.byId('composer-input') as HTMLTextAreaElement
    const send = this.#deps.byId('composer-send') as HTMLButtonElement
    input.disabled = !enabled
    send.disabled = !enabled
  }

  /** The right-hand context panel. */
  async refreshContext(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const facts = this.#deps.byId('context-facts')
    const questions = this.#deps.byId('context-questions')
    const drafts = this.#deps.byId('context-drafts')
    facts.replaceChildren()
    questions.replaceChildren()
    drafts.replaceChildren()
    if (!projectId) {
      this.#deps.setText('context-direction', '尚未打开项目')
      this.#deps.setText('context-baseline', '尚未冻结')
      return
    }
    const draftList = await this.#deps.api.listDrafts(projectId)
    for (const draft of draftList) {
      const li = document.createElement('li')
      li.textContent = (DRAFT_KIND_LABEL[draft.kind] ?? draft.kind) + '：' + draft.title + '（v' + draft.currentVersion + '）'
      drafts.append(li)
    }
    if (draftList.length === 0) {
      const li = document.createElement('li')
      li.className = 'context-empty'
      li.textContent = '还没有草稿'
      drafts.append(li)
    }
    const baselines = await this.#deps.api.listBaselines(projectId)
    this.#deps.setText('context-baseline', baselines.length === 0 ? '尚未冻结' : 'v' + baselines[0].version + '（' + baselines[0].name + '）')
  }

  // ------------------------------------------------------------------ drafts

  async refreshDrafts(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const list = this.#deps.byId('draft-list')
    list.replaceChildren()
    if (!projectId) {
      const li = document.createElement('li')
      li.className = 'draft-empty'
      li.textContent = '请先打开一个项目。'
      list.append(li)
      return
    }
    const drafts = await this.#deps.api.listDrafts(projectId)
    if (drafts.length === 0) {
      const li = document.createElement('li')
      li.className = 'draft-empty'
      li.textContent = '还没有草稿。'
      list.append(li)
      return
    }
    for (const draft of drafts) {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'draft-row' + (draft.id === this.#draftId ? ' is-active' : '')
      button.textContent = (DRAFT_KIND_LABEL[draft.kind] ?? draft.kind) + '：' + draft.title
      button.addEventListener('click', () => { void this.openDraft(draft.id) })
      li.append(button)
      list.append(li)
    }
  }

  async openDraft(draftId: string): Promise<void> {
    this.#draftId = draftId
    await this.refreshDrafts()
    const projectId = this.#deps.currentProjectId()
    if (!projectId) return
    const detail = await this.#deps.api.getDraft(projectId, draftId)
    const pane = this.#deps.byId('draft-detail')
    pane.replaceChildren()
    if (!detail) return

    const head = document.createElement('div')
    head.className = 'draft-detail-head'
    const title = document.createElement('h3')
    title.textContent = detail.draft.title
    const meta = document.createElement('span')
    meta.className = 'draft-meta'
    meta.textContent = 'v' + detail.draft.currentVersion + ' · ' + detail.draft.status
    head.append(title, meta)
    pane.append(head)

    const editor = document.createElement('textarea')
    editor.className = 'draft-editor'
    editor.rows = 14
    editor.value = detail.versions[0]?.content ?? ''
    pane.append(editor)

    const actions = document.createElement('div')
    actions.className = 'draft-actions'

    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'button button-small'
    save.textContent = '保存为新版本'
    save.addEventListener('click', async () => {
      await this.#deps.api.addDraftVersion(projectId, draftId, editor.value, '手动编辑')
      await this.openDraft(draftId)
      this.#deps.onChanged()
    })
    actions.append(save)

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'button button-ghost button-small'
    confirm.textContent = '标记为已确认'
    confirm.addEventListener('click', async () => {
      await this.#deps.api.setDraftStatus(projectId, draftId, 'CONFIRMED')
      await this.openDraft(draftId)
      this.#deps.onChanged()
    })
    actions.append(confirm)

    const reject = document.createElement('button')
    reject.type = 'button'
    reject.className = 'button button-ghost button-small'
    reject.textContent = '拒绝'
    reject.addEventListener('click', async () => {
      await this.#deps.api.setDraftStatus(projectId, draftId, 'REJECTED')
      await this.openDraft(draftId)
      this.#deps.onChanged()
    })
    actions.append(reject)
    pane.append(actions)

    const versions = document.createElement('div')
    versions.className = 'draft-versions'
    const heading = document.createElement('h4')
    heading.textContent = '版本历史'
    versions.append(heading)
    for (const version of detail.versions) {
      const row = document.createElement('div')
      row.className = 'draft-version-row'
      const label = document.createElement('span')
      label.textContent = 'v' + version.version + ' · ' + this.#deps.formatWhen(version.createdAt)
      const view = document.createElement('button')
      view.type = 'button'
      view.className = 'button button-ghost button-small'
      view.textContent = '查看'
      view.addEventListener('click', () => { editor.value = version.content })
      row.append(label, view)
      versions.append(row)
    }
    pane.append(versions)
  }

  async createDraft(kind: string, title: string): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('drafts-alert')
    alert.hidden = true
    if (!projectId) {
      alert.hidden = false
      alert.textContent = '请先打开一个项目。'
      return
    }
    if (title.trim().length === 0) {
      alert.hidden = false
      alert.textContent = '请填写草稿标题。'
      return
    }
    const draft = await this.#deps.api.createDraft(projectId, kind, title.trim(), '')
    await this.refreshDrafts()
    await this.openDraft(draft.id)
    this.#deps.onChanged()
  }

  // ------------------------------------------------------------------ research

  async refreshResearch(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const list = this.#deps.byId('research-list')
    list.replaceChildren()
    if (!projectId) return
    const reports = await this.#deps.api.listReports(projectId)
    if (reports.length === 0) {
      const li = document.createElement('li')
      li.className = 'research-empty'
      li.textContent = '还没有研究报告。'
      list.append(li)
      return
    }
    for (const report of reports) {
      const li = document.createElement('li')
      li.className = 'research-row'
      const title = document.createElement('div')
      title.className = 'research-title'
      title.textContent = report.title
      const meta = document.createElement('div')
      meta.className = 'research-meta'
      meta.textContent = this.#deps.formatWhen(report.createdAt) + ' · ' + report.sources.length + ' 个来源'
      const body = document.createElement('pre')
      body.className = 'research-body'
      body.textContent = report.content.slice(0, 2000)
      li.append(title, meta, body)
      if (report.sources.length > 0) {
        const sources = document.createElement('ul')
        sources.className = 'research-sources'
        for (const source of report.sources) {
          const item = document.createElement('li')
          const link = document.createElement('a')
          link.href = source.url
          link.textContent = source.title
          link.target = '_blank'
          link.rel = 'noreferrer'
          item.append(link)
          sources.append(item)
        }
        li.append(sources)
      }
      list.append(li)
    }
  }

  async runResearch(question: string): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('research-alert')
    alert.hidden = true
    if (!projectId) {
      alert.hidden = false
      alert.textContent = '请先打开一个项目。'
      return
    }
    if (question.trim().length === 0) return
    const request = await this.#deps.api.createResearch(projectId, question.trim())
    const result = await this.#deps.api.runResearch(projectId, request.id)
    if (!result.ok) {
      alert.hidden = false
      alert.textContent = '研究失败：' + (result.error ?? '未知原因')
    } else if (result.incomplete.length > 0) {
      alert.hidden = false
      alert.textContent = '报告缺少以下章节：' + result.incomplete.join('、')
    }
    await this.refreshResearch()
  }

  // ------------------------------------------------------------------ baselines

  async refreshBaselines(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const list = this.#deps.byId('baseline-list')
    list.replaceChildren()
    if (!projectId) {
      this.#deps.setText('baseline-headline', '请先打开一个项目。')
      return
    }
    const baselines = await this.#deps.api.listBaselines(projectId)
    this.#deps.setText('baseline-headline', baselines.length === 0 ? '尚未冻结任何基线。' : '共 ' + baselines.length + ' 个已冻结版本。')
    for (const baseline of baselines) {
      const li = document.createElement('li')
      li.className = 'baseline-row'
      const title = document.createElement('span')
      title.className = 'baseline-name'
      title.textContent = 'v' + baseline.version + ' · ' + baseline.name
      const meta = document.createElement('span')
      meta.className = 'baseline-meta'
      meta.textContent = this.#deps.formatWhen(baseline.frozenAt) + ' · ' + baseline.contentHash.slice(0, 12)
      li.append(title, meta)
      list.append(li)
    }
    await this.refreshProposals()
  }

  /** Build a preview from the current drafts and show the freeze confirmation. */
  async prepareBaseline(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('baseline-alert')
    alert.hidden = true
    if (!projectId) {
      alert.hidden = false
      alert.textContent = '请先打开一个项目。'
      return
    }
    const drafts = await this.#deps.api.listDrafts(projectId)
    if (drafts.length === 0) {
      alert.hidden = false
      alert.textContent = '还没有任何草稿。请先在「设计与素材」中创建设计草稿。'
      return
    }

    const sections = []
    for (const draft of drafts) {
      const detail = await this.#deps.api.getDraft(projectId, draft.id)
      sections.push({
        id: draft.id,
        title: (DRAFT_KIND_LABEL[draft.kind] ?? draft.kind) + '：' + draft.title,
        body: detail?.versions[0]?.content ?? '',
        confirmed: draft.status === 'CONFIRMED',
      })
    }

    const content = {
      name: '需求基线 v' + ((await this.#deps.api.listBaselines(projectId)).length + 1),
      summary: sections.map((s) => s.title).join('；'),
      sections,
      scope: sections.map((s) => s.title),
      outOfScope: [],
      openQuestions: [],
      risks: [],
      milestones: [],
      acceptance: [],
      sources: drafts.map((d) => ({ kind: 'draft', label: d.title, ref: d.id })),
    }
    this.#previewContent = content

    const preview = await this.#deps.api.previewBaseline(projectId, content)
    const card = this.#deps.byId('baseline-preview-card')
    card.hidden = false
    this.#deps.setText('preview-version', content.name)
    this.#deps.setText('preview-summary', content.summary)

    const unconfirmed = this.#deps.byId('preview-unconfirmed')
    if (preview.unconfirmed.length > 0) {
      unconfirmed.hidden = false
      unconfirmed.textContent = '以下章节尚未标记为已确认：' + preview.unconfirmed.join('、')
    } else {
      unconfirmed.hidden = true
    }

    const sectionBox = this.#deps.byId('preview-sections')
    sectionBox.replaceChildren()
    for (const section of sections) {
      const block = document.createElement('div')
      block.className = 'preview-section'
      const heading = document.createElement('h4')
      heading.textContent = section.title + (section.confirmed ? '（已确认）' : '（待确认）')
      const body = document.createElement('pre')
      body.className = 'preview-body'
      body.textContent = section.body || '（空）'
      block.append(heading, body)
      sectionBox.append(block)
    }

    this.#fillList('preview-scope', content.scope)
    this.#fillList('preview-outofscope', content.outOfScope.length > 0 ? content.outOfScope : ['（未填写）'])
    this.#fillList('preview-questions', preview.openQuestions.length > 0 ? preview.openQuestions : ['（无）'])
    this.#fillList('preview-risks', content.risks.length > 0 ? content.risks : ['（未填写）'])
    this.#fillList('preview-consequences', preview.consequences)

    const diffBox = this.#deps.byId('preview-diff')
    diffBox.replaceChildren()
    if (!preview.diff) {
      diffBox.textContent = '这是第一个版本，没有可比较的对象。'
    } else {
      const parts: string[] = []
      if (preview.diff.added.length) parts.push('新增：' + preview.diff.added.join('、'))
      if (preview.diff.removed.length) parts.push('移除：' + preview.diff.removed.join('、'))
      if (preview.diff.changed.length) parts.push('修改：' + preview.diff.changed.join('、'))
      diffBox.textContent = parts.length > 0 ? parts.join('\n') : '与上一版本没有差异。'
    }
  }

  #fillList(id: string, items: string[]): void {
    const list = this.#deps.byId(id)
    list.replaceChildren()
    for (const item of items) {
      const li = document.createElement('li')
      li.textContent = item
      list.append(li)
    }
  }

  async confirmFreeze(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('baseline-alert')
    alert.hidden = true
    if (!projectId || !this.#previewContent) return
    try {
      const baseline = await this.#deps.api.freezeBaseline(projectId, this.#previewContent, 'user')
      this.#deps.byId('baseline-preview-card').hidden = true
      this.#previewContent = null
      alert.hidden = false
      alert.textContent = '已冻结 v' + baseline.version + '，哈希 ' + baseline.contentHash.slice(0, 16) + '。'
      await this.refreshBaselines()
      this.#deps.onChanged()
    } catch (error) {
      alert.hidden = false
      alert.textContent = '冻结失败：' + this.#deps.describeError(error)
    }
  }

  cancelPreview(): void {
    this.#deps.byId('baseline-preview-card').hidden = true
    this.#previewContent = null
  }

  // ------------------------------------------------------------------ proposals

  async refreshProposals(): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const list = this.#deps.byId('proposal-list')
    list.replaceChildren()
    if (!projectId) return
    const proposals = await this.#deps.api.listProposals(projectId)
    const candidates = await this.#deps.api.listCandidates(projectId)
    this.#candidates = candidates
    if (proposals.length === 0) {
      const li = document.createElement('li')
      li.className = 'proposal-empty'
      li.textContent = '还没有变更提案。'
      list.append(li)
      return
    }
    for (const proposal of proposals) {
      const li = document.createElement('li')
      li.className = 'proposal-row'
      const head = document.createElement('div')
      head.className = 'proposal-head'
      const title = document.createElement('span')
      title.className = 'proposal-title'
      title.textContent = proposal.title
      const stage = proposalStage(proposal, candidates)
      const status = document.createElement('span')
      status.className = 'proposal-status proposal-status-' + stage.className
      status.textContent = stage.label
      head.append(title, status)
      li.append(head)

      const body = document.createElement('p')
      body.className = 'proposal-body'
      body.textContent = proposal.description
      li.append(body)

      if (proposal.impact) {
        const impact = document.createElement('div')
        impact.className = 'proposal-impact'
        const add = (label: string, items: string[]) => {
          if (items.length === 0) return
          const row = document.createElement('div')
          row.className = 'impact-row'
          const name = document.createElement('span')
          name.className = 'impact-label'
          name.textContent = label
          const value = document.createElement('span')
          value.textContent = items.join('、')
          row.append(name, value)
          impact.append(row)
        }
        add('受影响章节', proposal.impact.sections)
        add('受影响草稿', proposal.impact.drafts)
        add('需要返工', proposal.impact.rework)
        add('风险', proposal.impact.risks)
        add('未分析范围', proposal.impact.notAnalyzed)
        li.append(impact)
      }

      const actions = document.createElement('div')
      actions.className = 'proposal-actions'

      if (proposal.status === 'PENDING') {
        for (const [label, value] of [['批准', 'APPROVED'], ['拒绝', 'REJECTED'], ['需要修改', 'NEEDS_REVISION']] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'button button-small'
          button.textContent = label
          button.addEventListener('click', async () => {
            await this.#deps.api.decideProposal(projectId, proposal.id, value, 'user')
            await this.refreshProposals()
            this.#deps.onChanged()
          })
          actions.append(button)
        }
      }

      // An approved change is not a new version yet. The user asks for the candidate, looks
      // at the difference, and only then freezes it.
      if (proposal.status === 'APPROVED' && !stage.candidate) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'button button-small'
        button.textContent = '生成候选版本'
        button.addEventListener('click', async () => {
          try {
            await this.#deps.api.createCandidate(projectId, proposal.id)
          } catch (error) {
            const alert = this.#deps.byId('proposal-alert')
            alert.hidden = false
            alert.textContent = this.#deps.describeError(error)
          }
          await this.refreshProposals()
          this.#deps.onChanged()
        })
        actions.append(button)
      }

      if (proposal.status === 'APPROVED' && stage.candidate && !stage.candidate.frozenBaselineId) {
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.className = 'button button-danger button-small'
        confirm.textContent = '确认冻结为新版本'
        confirm.addEventListener('click', () => { void this.#confirmCandidate(projectId, stage.candidate!) })
        actions.append(confirm)

        const discard = document.createElement('button')
        discard.type = 'button'
        discard.className = 'button button-ghost button-small'
        discard.textContent = '放弃候选版本'
        discard.addEventListener('click', () => { void this.refreshProposals() })
        actions.append(discard)
      }

      if (actions.childElementCount > 0) li.append(actions)
      list.append(li)
    }
  }

  /** Show the candidate's difference from the baseline it would replace, then ask. */
  async #confirmCandidate(projectId: string, candidate: ReqCandidate): Promise<void> {
    const alert = this.#deps.byId('proposal-alert')
    alert.hidden = true
    const diff = await this.#deps.api.candidateDiff(projectId, candidate.id)
    const lines: string[] = ['这个候选版本将被冻结为新的正式版本，当前基线不会被修改。']
    if (diff) {
      if (diff.added.length) lines.push('新增章节：' + diff.added.join('、'))
      if (diff.removed.length) lines.push('移除章节：' + diff.removed.join('、'))
      if (diff.changed.length) lines.push('修改章节：' + diff.changed.join('、'))
      if (!diff.added.length && !diff.removed.length && !diff.changed.length) lines.push('章节结构没有变化。')
    }
    const proceed = window.confirm(lines.join('\n') + '\n\n确认冻结吗？')
    if (!proceed) return
    try {
      await this.#deps.api.freezeCandidate(projectId, candidate.id, 'user')
      await this.refreshProposals()
      await this.refreshBaselines()
      this.#deps.onChanged()
    } catch (error) {
      alert.hidden = false
      alert.textContent = this.#deps.describeError(error)
    }
  }

  async createProposal(title: string, description: string): Promise<void> {
    const projectId = this.#deps.currentProjectId()
    const alert = this.#deps.byId('proposal-alert')
    alert.hidden = true
    if (!projectId) {
      alert.hidden = false
      alert.textContent = '请先打开一个项目。'
      return
    }
    const baselines = await this.#deps.api.listBaselines(projectId)
    if (baselines.length === 0) {
      alert.hidden = false
      alert.textContent = '还没有冻结的基线，无法提出变更。'
      return
    }
    if (title.trim().length === 0 || description.trim().length === 0) {
      alert.hidden = false
      alert.textContent = '请填写变更标题和说明。'
      return
    }
    await this.#deps.api.createProposal(projectId, baselines[0].id, title.trim(), description.trim())
    await this.refreshProposals()
    this.#deps.onChanged()
  }

  /** Everything that depends on the open project. */
  async refreshAll(): Promise<void> {
    await this.refreshConversations()
    await this.refreshMessages()
    await this.refreshContext()
    await this.refreshDrafts()
    await this.refreshResearch()
    await this.refreshBaselines()
  }
}
