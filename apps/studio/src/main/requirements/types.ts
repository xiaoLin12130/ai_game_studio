/**
 * The requirement system's vocabulary.
 *
 * The distinction this file exists to make: a conversation is not a requirement. Ideas,
 * research, design drafts and GDD drafts are all things a user can change their mind about.
 * Only a RequirementBaseline is frozen, and only a user can freeze one.
 */

export type ConversationStatus = 'OPEN' | 'ARCHIVED'

export interface ConversationRecord {
  id: string
  projectId: string
  title: string
  status: ConversationStatus
  createdAt: string
  updatedAt: string
  lastMessageAt: string | null
}

/** Who produced a message. 'tool' is the runtime reporting a tool it ran. */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface MessageRecord {
  id: string
  conversationId: string
  role: MessageRole
  /** Free-form subtype: 'text', 'tool-call', 'tool-result', 'error'. */
  kind: string
  content: string
  /** DSH session this message belongs to, when it came from a runtime turn. */
  sessionId: string | null
  /** Monotonic within a conversation; the UI orders by this, never by timestamp. */
  seq: number
  createdAt: string
}

export type SessionLinkState = 'ACTIVE' | 'ENDED' | 'FAILED'

export interface SessionLinkRecord {
  conversationId: string
  sessionId: string
  runtimeId: string | null
  state: SessionLinkState
  createdAt: string
}

/** What a context snapshot was compiled for. */
export type ContextPurpose = 'advisor-turn' | 'research' | 'design' | 'baseline'

export interface ContextSource {
  kind: 'rule' | 'fact' | 'open-question' | 'attachment' | 'draft' | 'history' | 'project'
  label: string
  /** Characters contributed; used to show the budget breakdown. */
  size: number
  /** Where it came from, for traceability. */
  ref: string | null
}

export interface ContextSnapshotRecord {
  id: string
  projectId: string
  conversationId: string | null
  purpose: ContextPurpose
  sources: ContextSource[]
  /** Total characters after compilation. */
  size: number
  createdAt: string
}

export type AttachmentKind = 'image' | 'text' | 'document' | 'unsupported'

export interface AttachmentRecord {
  id: string
  projectId: string
  conversationId: string | null
  filename: string
  mime: string
  bytes: number
  sha256: string
  kind: AttachmentKind
  /** Extracted text for documents; null for images and unsupported files. */
  extractedText: string | null
  /** Absolute path inside the project's attachment directory. */
  storedPath: string
  createdAt: string
}

/** Draft kinds. A GDD is a draft like any other; it is not a requirement. */
export type DraftKind = 'idea' | 'design' | 'gdd'

export type DraftStatus = 'DRAFT' | 'CONFIRMED' | 'REJECTED'

export interface DraftRecord {
  id: string
  projectId: string
  kind: DraftKind
  title: string
  status: DraftStatus
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export interface DraftVersionRecord {
  id: string
  draftId: string
  version: number
  content: string
  note: string | null
  createdAt: string
}

export type ResearchStatus = 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'

export interface ResearchRequestRecord {
  id: string
  projectId: string
  conversationId: string | null
  question: string
  scope: string | null
  status: ResearchStatus
  createdAt: string
}

/**
 * One external source. A report that cites a URL must carry the title and the time it was
 * fetched, so a reader can tell a real citation from a plausible-looking one.
 */
export interface ResearchSource {
  title: string
  url: string
  fetchedAt: string
  /** 'search' when it came from a search result, 'fetch' when the page was read. */
  via: 'search' | 'fetch' | 'user'
  note: string | null
}

export interface ResearchReportRecord {
  id: string
  projectId: string
  requestId: string | null
  title: string
  /** Markdown body, with facts / inferences / suggestions kept in separate sections. */
  content: string
  sources: ResearchSource[]
  status: ResearchStatus
  createdAt: string
}

export type BaselineStatus = 'FROZEN'

export interface BaselineRecord {
  id: string
  projectId: string
  /** Monotonic per project, starting at 1. */
  version: number
  name: string
  content: string
  /** SHA-256 of the canonicalised content. */
  contentHash: string
  status: BaselineStatus
  createdAt: string
  frozenAt: string
  /** Who confirmed the freeze. A user action, recorded verbatim. */
  confirmedBy: string
  sourceDraftId: string | null
  previousBaselineId: string | null
}

export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION'

export interface ChangeProposalRecord {
  id: string
  projectId: string
  baselineId: string
  title: string
  description: string
  /** Structured impact analysis; null until it has been produced. */
  impact: ChangeImpact | null
  status: ProposalStatus
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  note: string | null
}

export interface ChangeImpact {
  /** Baseline sections the change touches. */
  sections: string[]
  /** Drafts that would need rework. */
  drafts: string[]
  /** Work that would have to be redone. */
  rework: string[]
  risks: string[]
  /** What this analysis did NOT cover. Never claim completeness. */
  notAnalyzed: string[]
}

export interface CreateConversationInput {
  projectId: string
  title: string
}

export interface AppendMessageInput {
  conversationId: string
  role: MessageRole
  kind: string
  content: string
  sessionId?: string | null
}
