/**
 * The project is the container everything else hangs off.
 *
 * A project is a directory the user chose, plus the decisions about what kind of game it
 * is. Tasks and DSH sessions belong to a project; closing a project never deletes them,
 * because the history of what was attempted is part of the project's record.
 */

export type EngineId = 'cocos-creator-3.8.6'
export type PlatformId = 'wechat-minigame'

/** What this build can actually create. Anything else is a field, not a promise. */
export const SUPPORTED_ENGINES: readonly EngineId[] = ['cocos-creator-3.8.6']
export const SUPPORTED_PLATFORMS: readonly PlatformId[] = ['wechat-minigame']

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED'

export interface ProjectRecord {
  id: string
  name: string
  /** Absolute, normalised root directory. The boundary for every file operation. */
  rootPath: string
  engine: EngineId
  platform: PlatformId
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  /** Last time the user opened it; null means never opened since creation. */
  lastOpenedAt: string | null
}

export interface ProjectConfigRecord {
  projectId: string
  /** Free-form settings the UI may extend without a migration. */
  settings: Record<string, unknown>
  updatedAt: string
}

export type ProjectEventKind =
  | 'project.created'
  | 'project.opened'
  | 'project.closed'
  | 'project.config.updated'
  | 'project.backup.created'
  | 'project.backup.restored'

export interface ProjectEventRecord {
  id: number
  projectId: string
  kind: ProjectEventKind
  summary: string | null
  at: string
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

/**
 * Approval exists as a data shape only in this phase.
 *
 * The decision centre that would create and act on these rows is PHASE 02 work; storing
 * the shape now means the schema does not have to change when that arrives.
 */
export interface ApprovalRecord {
  id: string
  projectId: string
  subject: string
  status: ApprovalStatus
  requestedAt: string
  decidedAt: string | null
  decidedBy: string | null
  note: string | null
}

export interface CreateProjectInput {
  name: string
  rootPath: string
  engine: EngineId
  platform: PlatformId
}

export interface ProjectView extends ProjectRecord {
  config: ProjectConfigRecord | null
  events: ProjectEventRecord[]
  taskCount: number
}
