/**
 * Persistence for the requirement system.
 *
 * Two rules are enforced here rather than in the UI, because a disabled button is not a
 * constraint:
 *
 *   1. A frozen baseline cannot be updated or deleted. The database triggers in the v3
 *      migration do the enforcing; this class refuses first so the caller gets a readable
 *      error instead of a SQLite abort.
 *   2. Every read is scoped to a project. A conversation, draft or attachment belonging to
 *      another project is not found, not "found but filtered".
 */
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AppendMessageInput,
  AttachmentKind,
  AttachmentRecord,
  BaselineRecord,
  ChangeImpact,
  ChangeProposalRecord,
  ContextPurpose,
  ContextSnapshotRecord,
  ContextSource,
  ConversationRecord,
  DraftKind,
  DraftRecord,
  DraftStatus,
  DraftVersionRecord,
  MessageRecord,
  MessageRole,
  ProposalStatus,
  ResearchReportRecord,
  ResearchRequestRecord,
  ResearchSource,
  ResearchStatus,
  SessionLinkRecord,
  SessionLinkState,
} from './types'

const iso = (value?: string) => value ?? new Date().toISOString()
const id = (prefix: string) => prefix + '-' + crypto.randomUUID().slice(0, 8)

/**
 * Canonical JSON: keys sorted, no whitespace.
 *
 * The hash of a baseline has to survive a round trip through JSON.parse/stringify, so it
 * cannot depend on key order. Two baselines with the same content must hash the same.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalise(v)).join(',') + '}'
}

export function hashContent(content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // Not JSON: hash the text itself, normalised for line endings.
    return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex')
  }
  return crypto.createHash('sha256').update(canonicalise(parsed)).digest('hex')
}

export class BaselineFrozenError extends Error {
  constructor(message: string) {
    super('BASELINE_FROZEN: ' + message)
    this.name = 'BaselineFrozenError'
  }
}

export class RequirementStore {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  // ------------------------------------------------------------------ conversations

  createConversation(input: { projectId: string; title: string; now?: string }): ConversationRecord {
    const at = iso(input.now)
    const conversationId = id('conv')
    this.#db
      .prepare(
        "INSERT INTO advisor_conversations (id, project_id, title, status, created_at, updated_at, last_message_at) VALUES (?, ?, ?, 'OPEN', ?, ?, NULL)",
      )
      .run(conversationId, input.projectId, input.title, at, at)
    return this.getConversation(input.projectId, conversationId) as ConversationRecord
  }

  getConversation(projectId: string, conversationId: string): ConversationRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM advisor_conversations WHERE id = ? AND project_id = ?')
      .get(conversationId, projectId) as Record<string, unknown> | undefined
    return row ? this.#mapConversation(row) : null
  }

  listConversations(projectId: string, limit = 100): ConversationRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM advisor_conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[]
    return rows.map((row) => this.#mapConversation(row))
  }

  #mapConversation(row: Record<string, unknown>): ConversationRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      status: String(row.status) as ConversationRecord['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
    }
  }

  // ------------------------------------------------------------------ messages

  appendMessage(input: AppendMessageInput & { now?: string }): MessageRecord {
    const at = iso(input.now)
    return this.#transaction(() => {
      const next = this.#db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM advisor_messages WHERE conversation_id = ?')
        .get(input.conversationId) as { seq: number }
      const messageId = id('msg')
      this.#db
        .prepare(
          'INSERT INTO advisor_messages (id, conversation_id, role, kind, content, session_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(messageId, input.conversationId, input.role, input.kind, input.content, input.sessionId ?? null, next.seq, at)
      this.#db
        .prepare('UPDATE advisor_conversations SET updated_at = ?, last_message_at = ? WHERE id = ?')
        .run(at, at, input.conversationId)
      return this.getMessage(input.conversationId, messageId) as MessageRecord
    })
  }

  getMessage(conversationId: string, messageId: string): MessageRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM advisor_messages WHERE id = ? AND conversation_id = ?')
      .get(messageId, conversationId) as Record<string, unknown> | undefined
    return row ? this.#mapMessage(row) : null
  }

  listMessages(conversationId: string, options: { limit?: number; beforeSeq?: number } = {}): MessageRecord[] {
    const limit = options.limit ?? 200
    const rows = options.beforeSeq
      ? (this.#db
          .prepare('SELECT * FROM advisor_messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(conversationId, options.beforeSeq, limit) as Record<string, unknown>[])
      : (this.#db
          .prepare('SELECT * FROM advisor_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
          .all(conversationId, limit) as Record<string, unknown>[])
    return rows.map((row) => this.#mapMessage(row)).reverse()
  }

  countMessages(conversationId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM advisor_messages WHERE conversation_id = ?')
      .get(conversationId) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  #mapMessage(row: Record<string, unknown>): MessageRecord {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      role: String(row.role) as MessageRole,
      kind: String(row.kind),
      content: String(row.content),
      sessionId: row.session_id ? String(row.session_id) : null,
      seq: Number(row.seq),
      createdAt: String(row.created_at),
    }
  }

  // ------------------------------------------------------------------ session links

  linkSession(input: { conversationId: string; sessionId: string; runtimeId?: string | null; state?: SessionLinkState; now?: string }): void {
    this.#db
      .prepare(
        `INSERT INTO advisor_session_links (conversation_id, session_id, runtime_id, state, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, session_id) DO UPDATE SET runtime_id = excluded.runtime_id, state = excluded.state`,
      )
      .run(input.conversationId, input.sessionId, input.runtimeId ?? null, input.state ?? 'ACTIVE', iso(input.now))
  }

  listSessionLinks(conversationId: string): SessionLinkRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM advisor_session_links WHERE conversation_id = ? ORDER BY created_at')
      .all(conversationId) as Record<string, unknown>[]
    return rows.map((row) => ({
      conversationId: String(row.conversation_id),
      sessionId: String(row.session_id),
      runtimeId: row.runtime_id ? String(row.runtime_id) : null,
      state: String(row.state) as SessionLinkState,
      createdAt: String(row.created_at),
    }))
  }

  // ------------------------------------------------------------------ context snapshots

  recordContext(input: {
    projectId: string
    conversationId: string | null
    purpose: ContextPurpose
    sources: ContextSource[]
    size: number
    now?: string
  }): ContextSnapshotRecord {
    const snapshotId = id('ctx')
    const at = iso(input.now)
    this.#db
      .prepare('INSERT INTO context_snapshots (id, project_id, conversation_id, purpose, sources, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(snapshotId, input.projectId, input.conversationId, input.purpose, JSON.stringify(input.sources), input.size, at)
    return {
      id: snapshotId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      purpose: input.purpose,
      sources: input.sources,
      size: input.size,
      createdAt: at,
    }
  }

  listContexts(projectId: string, limit = 20): ContextSnapshotRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM context_snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      purpose: String(row.purpose) as ContextPurpose,
      sources: JSON.parse(String(row.sources)) as ContextSource[],
      size: Number(row.size),
      createdAt: String(row.created_at),
    }))
  }

  // ------------------------------------------------------------------ attachments

  createAttachment(input: {
    projectId: string
    conversationId?: string | null
    filename: string
    mime: string
    bytes: number
    sha256: string
    kind: AttachmentKind
    extractedText?: string | null
    storedPath: string
    now?: string
  }): AttachmentRecord {
    const attachmentId = id('att')
    const at = iso(input.now)
    this.#db
      .prepare(
        `INSERT INTO attachments (id, project_id, conversation_id, filename, mime, bytes, sha256, kind, extracted_text, stored_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachmentId,
        input.projectId,
        input.conversationId ?? null,
        input.filename,
        input.mime,
        input.bytes,
        input.sha256,
        input.kind,
        input.extractedText ?? null,
        input.storedPath,
        at,
      )
    return this.getAttachment(input.projectId, attachmentId) as AttachmentRecord
  }

  getAttachment(projectId: string, attachmentId: string): AttachmentRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM attachments WHERE id = ? AND project_id = ?')
      .get(attachmentId, projectId) as Record<string, unknown> | undefined
    return row ? this.#mapAttachment(row) : null
  }

  listAttachments(projectId: string, conversationId?: string | null): AttachmentRecord[] {
    const rows = conversationId
      ? (this.#db
          .prepare('SELECT * FROM attachments WHERE project_id = ? AND conversation_id = ? ORDER BY created_at')
          .all(projectId, conversationId) as Record<string, unknown>[])
      : (this.#db
          .prepare('SELECT * FROM attachments WHERE project_id = ? ORDER BY created_at')
          .all(projectId) as Record<string, unknown>[])
    return rows.map((row) => this.#mapAttachment(row))
  }

  deleteAttachment(projectId: string, attachmentId: string): boolean {
    const info = this.#db.prepare('DELETE FROM attachments WHERE id = ? AND project_id = ?').run(attachmentId, projectId)
    return Number(info.changes ?? 0) > 0
  }

  #mapAttachment(row: Record<string, unknown>): AttachmentRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      filename: String(row.filename),
      mime: String(row.mime),
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
      kind: String(row.kind) as AttachmentKind,
      extractedText: row.extracted_text ? String(row.extracted_text) : null,
      storedPath: String(row.stored_path),
      createdAt: String(row.created_at),
    }
  }

  // ------------------------------------------------------------------ drafts

  createDraft(input: { projectId: string; kind: DraftKind; title: string; content: string; note?: string | null; now?: string }): DraftRecord {
    const at = iso(input.now)
    const draftId = id('draft')
    return this.#transaction(() => {
      this.#db
        .prepare(
          "INSERT INTO drafts (id, project_id, kind, title, status, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'DRAFT', 1, ?, ?)",
        )
        .run(draftId, input.projectId, input.kind, input.title, at, at)
      this.#db
        .prepare('INSERT INTO draft_versions (id, draft_id, version, content, note, created_at) VALUES (?, ?, 1, ?, ?, ?)')
        .run(id('dv'), draftId, input.content, input.note ?? null, at)
      return this.getDraft(input.projectId, draftId) as DraftRecord
    })
  }

  getDraft(projectId: string, draftId: string): DraftRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM drafts WHERE id = ? AND project_id = ?')
      .get(draftId, projectId) as Record<string, unknown> | undefined
    return row ? this.#mapDraft(row) : null
  }

  listDrafts(projectId: string, kind?: DraftKind): DraftRecord[] {
    const rows = kind
      ? (this.#db.prepare('SELECT * FROM drafts WHERE project_id = ? AND kind = ? ORDER BY updated_at DESC').all(projectId, kind) as Record<string, unknown>[])
      : (this.#db.prepare('SELECT * FROM drafts WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Record<string, unknown>[])
    return rows.map((row) => this.#mapDraft(row))
  }

  #mapDraft(row: Record<string, unknown>): DraftRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      kind: String(row.kind) as DraftKind,
      title: String(row.title),
      status: String(row.status) as DraftStatus,
      currentVersion: Number(row.current_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  /** Add a new version. The previous versions stay readable; nothing is overwritten. */
  addDraftVersion(input: { projectId: string; draftId: string; content: string; note?: string | null; now?: string }): DraftVersionRecord {
    const at = iso(input.now)
    return this.#transaction(() => {
      const draft = this.getDraft(input.projectId, input.draftId)
      if (!draft) throw new Error('unknown draft: ' + input.draftId)
      const version = draft.currentVersion + 1
      this.#db
        .prepare('INSERT INTO draft_versions (id, draft_id, version, content, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id('dv'), input.draftId, version, input.content, input.note ?? null, at)
      this.#db.prepare('UPDATE drafts SET current_version = ?, updated_at = ? WHERE id = ?').run(version, at, input.draftId)
      return this.getDraftVersion(input.draftId, version) as DraftVersionRecord
    })
  }

  getDraftVersion(draftId: string, version: number): DraftVersionRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM draft_versions WHERE draft_id = ? AND version = ?')
      .get(draftId, version) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      draftId: String(row.draft_id),
      version: Number(row.version),
      content: String(row.content),
      note: row.note ? String(row.note) : null,
      createdAt: String(row.created_at),
    }
  }

  listDraftVersions(draftId: string): DraftVersionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY version DESC')
      .all(draftId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      draftId: String(row.draft_id),
      version: Number(row.version),
      content: String(row.content),
      note: row.note ? String(row.note) : null,
      createdAt: String(row.created_at),
    }))
  }

  setDraftStatus(projectId: string, draftId: string, status: DraftStatus, now?: string): DraftRecord {
    this.#db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(status, iso(now), draftId, projectId)
    return this.getDraft(projectId, draftId) as DraftRecord
  }

  // ------------------------------------------------------------------ research

  createResearchRequest(input: { projectId: string; conversationId?: string | null; question: string; scope?: string | null; now?: string }): ResearchRequestRecord {
    const requestId = id('rr')
    const at = iso(input.now)
    this.#db
      .prepare("INSERT INTO research_requests (id, project_id, conversation_id, question, scope, status, created_at) VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?)")
      .run(requestId, input.projectId, input.conversationId ?? null, input.question, input.scope ?? null, at)
    return this.getResearchRequest(input.projectId, requestId) as ResearchRequestRecord
  }

  getResearchRequest(projectId: string, requestId: string): ResearchRequestRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM research_requests WHERE id = ? AND project_id = ?')
      .get(requestId, projectId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      question: String(row.question),
      scope: row.scope ? String(row.scope) : null,
      status: String(row.status) as ResearchStatus,
      createdAt: String(row.created_at),
    }
  }

  listResearchRequests(projectId: string): ResearchRequestRecord[] {
    const rows = this.#db
      .prepare('SELECT id FROM research_requests WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as { id: string }[]
    return rows.map((row) => this.getResearchRequest(projectId, row.id) as ResearchRequestRecord)
  }

  setResearchStatus(projectId: string, requestId: string, status: ResearchStatus): void {
    this.#db.prepare('UPDATE research_requests SET status = ? WHERE id = ? AND project_id = ?').run(status, requestId, projectId)
  }

  createResearchReport(input: {
    projectId: string
    requestId?: string | null
    title: string
    content: string
    sources: ResearchSource[]
    status?: ResearchStatus
    now?: string
  }): ResearchReportRecord {
    const reportId = id('rep')
    const at = iso(input.now)
    this.#db
      .prepare('INSERT INTO research_reports (id, project_id, request_id, title, content, sources, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(reportId, input.projectId, input.requestId ?? null, input.title, input.content, JSON.stringify(input.sources), input.status ?? 'COMPLETED', at)
    return this.getResearchReport(input.projectId, reportId) as ResearchReportRecord
  }

  getResearchReport(projectId: string, reportId: string): ResearchReportRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM research_reports WHERE id = ? AND project_id = ?')
      .get(reportId, projectId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      requestId: row.request_id ? String(row.request_id) : null,
      title: String(row.title),
      content: String(row.content),
      sources: JSON.parse(String(row.sources)) as ResearchSource[],
      status: String(row.status) as ResearchStatus,
      createdAt: String(row.created_at),
    }
  }

  listResearchReports(projectId: string): ResearchReportRecord[] {
    const rows = this.#db
      .prepare('SELECT id FROM research_reports WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as { id: string }[]
    return rows.map((row) => this.getResearchReport(projectId, row.id) as ResearchReportRecord)
  }

  // ------------------------------------------------------------------ baselines

  /**
   * Freeze a new baseline version.
   *
   * The version number is derived from what already exists, inside the transaction, so two
   * concurrent freezes cannot both claim version 2. The hash is computed here, not passed
   * in: a caller that supplies its own hash could freeze content that does not match it.
   */
  freezeBaseline(input: {
    projectId: string
    name: string
    content: string
    confirmedBy: string
    sourceDraftId?: string | null
    now?: string
  }): BaselineRecord {
    const at = iso(input.now)
    return this.#transaction(() => {
      const last = this.#db
        .prepare('SELECT version, id FROM requirement_baselines WHERE project_id = ? ORDER BY version DESC LIMIT 1')
        .get(input.projectId) as { version: number; id: string } | undefined
      const version = (last?.version ?? 0) + 1
      const baselineId = id('base')
      this.#db
        .prepare(
          `INSERT INTO requirement_baselines
             (id, project_id, version, name, content, content_hash, status, created_at, frozen_at, confirmed_by, source_draft_id, previous_baseline_id)
           VALUES (?, ?, ?, ?, ?, ?, 'FROZEN', ?, ?, ?, ?, ?)`,
        )
        .run(
          baselineId,
          input.projectId,
          version,
          input.name,
          input.content,
          hashContent(input.content),
          at,
          at,
          input.confirmedBy,
          input.sourceDraftId ?? null,
          last?.id ?? null,
        )
      return this.getBaseline(input.projectId, baselineId) as BaselineRecord
    })
  }

  getBaseline(projectId: string, baselineId: string): BaselineRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM requirement_baselines WHERE id = ? AND project_id = ?')
      .get(baselineId, projectId) as Record<string, unknown> | undefined
    return row ? this.#mapBaseline(row) : null
  }

  latestBaseline(projectId: string): BaselineRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM requirement_baselines WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as Record<string, unknown> | undefined
    return row ? this.#mapBaseline(row) : null
  }

  listBaselines(projectId: string): BaselineRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM requirement_baselines WHERE project_id = ? ORDER BY version DESC')
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.#mapBaseline(row))
  }

  #mapBaseline(row: Record<string, unknown>): BaselineRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      version: Number(row.version),
      name: String(row.name),
      content: String(row.content),
      contentHash: String(row.content_hash),
      status: 'FROZEN',
      createdAt: String(row.created_at),
      frozenAt: String(row.frozen_at),
      confirmedBy: String(row.confirmed_by),
      sourceDraftId: row.source_draft_id ? String(row.source_draft_id) : null,
      previousBaselineId: row.previous_baseline_id ? String(row.previous_baseline_id) : null,
    }
  }

  /**
   * Attempt to modify a frozen baseline. Always refused.
   *
   * This exists so the refusal is a typed, readable error rather than a SQLite abort, and so
   * a test can prove the constraint without going through the UI.
   */
  updateBaseline(): never {
    throw new BaselineFrozenError('a frozen baseline cannot be modified; create a new version instead')
  }

  // ------------------------------------------------------------------ change proposals

  createProposal(input: {
    projectId: string
    baselineId: string
    title: string
    description: string
    impact?: ChangeImpact | null
    now?: string
  }): ChangeProposalRecord {
    const proposalId = id('cp')
    const at = iso(input.now)
    this.#db
      .prepare(
        "INSERT INTO change_proposals (id, project_id, baseline_id, title, description, impact, status, created_at, decided_at, decided_by, note) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, NULL, NULL)",
      )
      .run(proposalId, input.projectId, input.baselineId, input.title, input.description, input.impact ? JSON.stringify(input.impact) : null, at)
    return this.getProposal(input.projectId, proposalId) as ChangeProposalRecord
  }

  getProposal(projectId: string, proposalId: string): ChangeProposalRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM change_proposals WHERE id = ? AND project_id = ?')
      .get(proposalId, projectId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      baselineId: String(row.baseline_id),
      title: String(row.title),
      description: String(row.description),
      impact: row.impact ? (JSON.parse(String(row.impact)) as ChangeImpact) : null,
      status: String(row.status) as ProposalStatus,
      createdAt: String(row.created_at),
      decidedAt: row.decided_at ? String(row.decided_at) : null,
      decidedBy: row.decided_by ? String(row.decided_by) : null,
      note: row.note ? String(row.note) : null,
    }
  }

  listProposals(projectId: string): ChangeProposalRecord[] {
    const rows = this.#db
      .prepare('SELECT id FROM change_proposals WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as { id: string }[]
    return rows.map((row) => this.getProposal(projectId, row.id) as ChangeProposalRecord)
  }

  setProposalImpact(projectId: string, proposalId: string, impact: ChangeImpact): ChangeProposalRecord {
    this.#db.prepare('UPDATE change_proposals SET impact = ? WHERE id = ? AND project_id = ?').run(JSON.stringify(impact), proposalId, projectId)
    return this.getProposal(projectId, proposalId) as ChangeProposalRecord
  }

  decideProposal(input: {
    projectId: string
    proposalId: string
    status: Exclude<ProposalStatus, 'PENDING'>
    decidedBy: string
    note?: string | null
    now?: string
  }): ChangeProposalRecord {
    const at = iso(input.now)
    this.#db
      .prepare('UPDATE change_proposals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND project_id = ?')
      .run(input.status, at, input.decidedBy, input.note ?? null, input.proposalId, input.projectId)
    return this.getProposal(input.projectId, input.proposalId) as ChangeProposalRecord
  }
}
