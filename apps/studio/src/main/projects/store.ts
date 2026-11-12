/**
 * Project persistence, on the same database as tasks.
 *
 * The project tables are a v2 migration of the task store rather than a second database:
 * a project owns tasks, and the foreign key is what makes "closing a project does not
 * delete its history" a property of the schema instead of a promise in a comment.
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  ApprovalRecord,
  ApprovalStatus,
  EngineId,
  PlatformId,
  ProjectConfigRecord,
  ProjectEventKind,
  ProjectEventRecord,
  ProjectRecord,
  ProjectStatus,
  ProjectView,
} from './types'

export interface ProjectStoreDb {
  db: DatabaseSync
}

const iso = (value?: string) => value ?? new Date().toISOString()

export class ProjectStore {
  readonly #db: DatabaseSync

  constructor(database: ProjectStoreDb) {
    this.#db = database.db
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

  create(input: { id: string; name: string; rootPath: string; engine: EngineId; platform: PlatformId; now?: string }): ProjectRecord {
    const now = iso(input.now)
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO projects (id, name, root_path, engine, platform, status, created_at, updated_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL)`,
        )
        .run(input.id, input.name, input.rootPath, input.engine, input.platform, now, now)
      this.#db
        .prepare('INSERT INTO project_configs (project_id, settings, updated_at) VALUES (?, ?, ?)')
        .run(input.id, JSON.stringify({}), now)
      this.#db
        .prepare('INSERT INTO project_events (project_id, kind, summary, at) VALUES (?, ?, ?, ?)')
        .run(input.id, 'project.created', input.name, now)
      return this.get(input.id) as ProjectRecord
    })
  }

  get(id: string): ProjectRecord | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.#map(row) : null
  }

  findByRoot(rootPath: string): ProjectRecord | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Record<string, unknown> | undefined
    return row ? this.#map(row) : null
  }

  list(limit = 200): ProjectRecord[] {
    const rows = this.#db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map((row) => this.#map(row))
  }

  #map(row: Record<string, unknown>): ProjectRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      engine: String(row.engine) as EngineId,
      platform: String(row.platform) as PlatformId,
      status: String(row.status) as ProjectStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastOpenedAt: row.last_opened_at ? String(row.last_opened_at) : null,
    }
  }

  touchOpened(id: string, now?: string): void {
    const at = iso(now)
    this.#transaction(() => {
      this.#db.prepare('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
      this.#db.prepare('INSERT INTO project_events (project_id, kind, summary, at) VALUES (?, ?, ?, ?)').run(id, 'project.opened', null, at)
    })
  }

  recordClosed(id: string, now?: string): void {
    const at = iso(now)
    this.#transaction(() => {
      this.#db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, id)
      this.#db.prepare('INSERT INTO project_events (project_id, kind, summary, at) VALUES (?, ?, ?, ?)').run(id, 'project.closed', null, at)
    })
  }

  updateConfig(projectId: string, settings: Record<string, unknown>, now?: string): ProjectConfigRecord {
    const at = iso(now)
    return this.#transaction(() => {
      this.#db
        .prepare('UPDATE project_configs SET settings = ?, updated_at = ? WHERE project_id = ?')
        .run(JSON.stringify(settings), at, projectId)
      this.#db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, projectId)
      this.#db
        .prepare('INSERT INTO project_events (project_id, kind, summary, at) VALUES (?, ?, ?, ?)')
        .run(projectId, 'project.config.updated', Object.keys(settings).join(','), at)
      return this.getConfig(projectId) as ProjectConfigRecord
    })
  }

  getConfig(projectId: string): ProjectConfigRecord | null {
    const row = this.#db.prepare('SELECT * FROM project_configs WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      projectId: String(row.project_id),
      settings: JSON.parse(String(row.settings)) as Record<string, unknown>,
      updatedAt: String(row.updated_at),
    }
  }

  appendEvent(projectId: string, kind: ProjectEventKind, summary?: string | null, now?: string): void {
    this.#db
      .prepare('INSERT INTO project_events (project_id, kind, summary, at) VALUES (?, ?, ?, ?)')
      .run(projectId, kind, summary ?? null, iso(now))
  }

  listEvents(projectId: string, limit = 50): ProjectEventRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      projectId: String(row.project_id),
      kind: String(row.kind) as ProjectEventKind,
      summary: row.summary ? String(row.summary) : null,
      at: String(row.at),
    }))
  }

  countTasks(projectId: string): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(projectId) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  view(id: string): ProjectView | null {
    const project = this.get(id)
    if (!project) return null
    return {
      ...project,
      config: this.getConfig(id),
      events: this.listEvents(id),
      taskCount: this.countTasks(id),
    }
  }

  // ---------------------------------------------------------------- approvals (shape only)

  createApproval(input: { id: string; projectId: string; subject: string; now?: string }): ApprovalRecord {
    const at = iso(input.now)
    this.#db
      .prepare('INSERT INTO approvals (id, project_id, subject, status, requested_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.projectId, input.subject, 'PENDING', at)
    return this.getApproval(input.id) as ApprovalRecord
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      subject: String(row.subject),
      status: String(row.status) as ApprovalStatus,
      requestedAt: String(row.requested_at),
      decidedAt: row.decided_at ? String(row.decided_at) : null,
      decidedBy: row.decided_by ? String(row.decided_by) : null,
      note: row.note ? String(row.note) : null,
    }
  }

  listApprovals(projectId: string): ApprovalRecord[] {
    const rows = this.#db.prepare('SELECT id FROM approvals WHERE project_id = ? ORDER BY requested_at').all(projectId) as { id: string }[]
    return rows.map((row) => this.getApproval(row.id) as ApprovalRecord)
  }
}
