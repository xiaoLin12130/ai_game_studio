/**
 * Durable task state in SQLite (node:sqlite, built into the Electron runtime).
 *
 * Chosen over the JSON files used elsewhere because a task's status and the history that
 * explains it have to move together: losing the transition row while keeping the new
 * status would leave a task nobody can account for. Every state change here is one
 * transaction, and the unique constraints stop a retried event from creating a second
 * attempt.
 *
 * Big payloads stay out of the database. Full event streams live in files under
 * <userData>/records and the database keeps the relative path.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertTransition, canTransition } from './machine'
import type {
  AcceptanceSpec,
  AttemptRecord,
  AttemptStatus,
  SessionRecord,
  SessionState,
  TaskIsolation,
  TaskRecord,
  TaskStatus,
  TaskView,
  TransitionRecord,
  TransitionSource,
  VerificationRecord,
} from './types'

export const SCHEMA_VERSION = 2

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    type TEXT NOT NULL,
    isolation TEXT NOT NULL CHECK (isolation IN ('readonly','writable')),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    current_attempt_id TEXT,
    acceptance TEXT NOT NULL,
    last_error_code TEXT,
    last_error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);

  CREATE TABLE IF NOT EXISTS task_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    session_id TEXT,
    attempt_id TEXT,
    error_code TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_transitions(task_id, id);

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    session_id TEXT,
    runtime_id TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    error_code TEXT,
    error_message TEXT,
    record_path TEXT,
    UNIQUE (task_id, attempt_no)
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    runtime_id TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);

  CREATE TABLE IF NOT EXISTS runtimes (
    id TEXT PRIMARY KEY,
    isolation TEXT NOT NULL,
    pid INTEGER,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    ok INTEGER NOT NULL,
    code TEXT,
    detail TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(task_id, id);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT,
    kind TEXT NOT NULL,
    summary TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);

  INSERT INTO schema_version (version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
  `,
  // v2 — projects. Added in PHASE 01-D on top of the task tables, in the same database:
  // a project owns tasks, and splitting them across two files would make the ownership
  // unenforceable by the engine.
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    engine TEXT NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT
  );
  -- Two projects may not share a root: that is the isolation boundary.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root ON projects(root_path);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, updated_at DESC);

  CREATE TABLE IF NOT EXISTS project_configs (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    summary TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_events ON project_events(project_id, id);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id, requested_at);

  -- Tasks gain an owner. Nullable on purpose: tasks created before this migration have no
  -- project, and deleting a project must not delete the history of what was attempted.
  ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, updated_at DESC);

  -- Project-level mutual exclusion. Rows, not files: a file that exists is not proof its
  -- owner is alive, and treating it as proof is how a crash locks a project forever.
  CREATE TABLE IF NOT EXISTS project_locks (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('write','build')),
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    PRIMARY KEY (project_id, kind)
  );
  `,
]

export interface CreateTaskInput {
  id: string
  title: string
  goal: string
  type: string
  isolation: TaskIsolation
  acceptance: AcceptanceSpec
  /** Optional: tasks created before PHASE 01-D have no project. */
  projectId?: string | null
  now?: string
}

export interface TransitionInput {
  taskId: string
  to: TaskStatus
  reason: string
  source: TransitionSource
  sessionId?: string | null
  attemptId?: string | null
  errorCode?: string | null
  now?: string
}

const iso = (value?: string) => value ?? new Date().toISOString()

export class TaskStore {
  /** The live connection. Replaced by adopt() after a restore swaps the file. */
  db: DatabaseSync
  readonly #dbPath: string

  constructor(dbPath: string) {
    this.#dbPath = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.#migrate()
  }

  #migrate(): void {
    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { name?: string } | undefined
    let current = 0
    if (hasTable?.name) {
      const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined
      current = Number(row?.version ?? 0)
    }
    if (current > MIGRATIONS.length) {
      throw new Error(`task database is at schema v${current}, newer than this build (${MIGRATIONS.length}); refusing to guess`)
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(MIGRATIONS[version])
        this.db.exec('DELETE FROM schema_version')
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version + 1)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  get schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined
    return Number(row?.version ?? 0)
  }

  /**
   * Point this store at a new connection.
   *
   * Used after a restore: the old connection refers to a file that was replaced, so every
   * prepared statement on it is stale. Swapping the handle keeps one store object for the
   * whole app instead of threading a new one through every caller.
   */
  adopt(db: DatabaseSync): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
    this.db = db
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  #transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---------------------------------------------------------------- tasks

  createTask(input: CreateTaskInput): TaskRecord {
    const now = iso(input.now)
    return this.#transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, goal, type, isolation, status, created_at, updated_at, current_attempt_id, acceptance, last_error_code, last_error_message, project_id)
           VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?, NULL, ?, NULL, NULL, ?)`,
        )
        .run(input.id, input.title, input.goal, input.type, input.isolation, now, now, JSON.stringify(input.acceptance), input.projectId ?? null)
      this.db
        .prepare(
          `INSERT INTO task_transitions (task_id, from_status, to_status, reason, source, at, session_id, attempt_id, error_code)
           VALUES (?, 'CREATED', 'CREATED', ?, 'system', ?, NULL, NULL, NULL)`,
        )
        .run(input.id, 'task created', now)
      return this.#task(input.id) as TaskRecord
    })
  }

  #task(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.#mapTask(row) : null
  }

  #mapTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      goal: String(row.goal),
      type: String(row.type),
      isolation: String(row.isolation) as TaskIsolation,
      status: String(row.status) as TaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      currentAttemptId: row.current_attempt_id ? String(row.current_attempt_id) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      acceptance: JSON.parse(String(row.acceptance)) as AcceptanceSpec,
      lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
      lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
    }
  }

  getTask(id: string): TaskRecord | null {
    return this.#task(id)
  }

  listTasks(limit = 200): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map((row) => this.#mapTask(row))
  }

  /**
   * Move a task to a new status, recording why, in one transaction.
   *
   * The transition table is enforced here, not in the caller: a status can only be reached
   * by a legal edge, and the row that explains it is written in the same transaction.
   */
  transition(input: TransitionInput): TaskRecord {
    const now = iso(input.now)
    return this.#transaction(() => {
      const current = this.#task(input.taskId)
      if (!current) throw new Error('unknown task: ' + input.taskId)
      assertTransition(current.status, input.to)
      this.db
        .prepare('UPDATE tasks SET status = ?, updated_at = ?, last_error_code = ?, last_error_message = ? WHERE id = ?')
        .run(input.to, now, input.errorCode ?? null, input.errorCode ? (input.reason ?? null) : null, input.taskId)
      this.db
        .prepare(
          `INSERT INTO task_transitions (task_id, from_status, to_status, reason, source, at, session_id, attempt_id, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.taskId, current.status, input.to, input.reason, input.source, now, input.sessionId ?? null, input.attemptId ?? null, input.errorCode ?? null)
      return this.#task(input.taskId) as TaskRecord
    })
  }

  listTransitions(taskId: string): TransitionRecord[] {
    const rows = this.db.prepare('SELECT * FROM task_transitions WHERE task_id = ? ORDER BY id ASC').all(taskId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      from: String(row.from_status) as TaskStatus,
      to: String(row.to_status) as TaskStatus,
      reason: String(row.reason),
      source: String(row.source) as TransitionSource,
      at: String(row.at),
      sessionId: row.session_id ? String(row.session_id) : null,
      attemptId: row.attempt_id ? String(row.attempt_id) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
    }))
  }

  // ---------------------------------------------------------------- attempts

  createAttempt(input: { id: string; taskId: string; attemptNo: number; sessionId?: string | null; runtimeId?: string | null; now?: string }): AttemptRecord {
    const now = iso(input.now)
    return this.#transaction(() => {
      this.db
        .prepare(
          `INSERT INTO attempts (id, task_id, attempt_no, session_id, runtime_id, status, started_at, ended_at, error_code, error_message, record_path)
           VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, NULL, NULL, NULL, NULL)`,
        )
        .run(input.id, input.taskId, input.attemptNo, input.sessionId ?? null, input.runtimeId ?? null, now)
      this.db.prepare('UPDATE tasks SET current_attempt_id = ?, updated_at = ? WHERE id = ?').run(input.id, now, input.taskId)
      return this.getAttempt(input.id) as AttemptRecord
    })
  }

  getAttempt(id: string): AttemptRecord | null {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.#mapAttempt(row) : null
  }

  #mapAttempt(row: Record<string, unknown>): AttemptRecord {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      attemptNo: Number(row.attempt_no),
      sessionId: row.session_id ? String(row.session_id) : null,
      runtimeId: row.runtime_id ? String(row.runtime_id) : null,
      status: String(row.status) as AttemptStatus,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      recordPath: row.record_path ? String(row.record_path) : null,
    }
  }

  listAttempts(taskId: string): AttemptRecord[] {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC').all(taskId) as Record<string, unknown>[]
    return rows.map((row) => this.#mapAttempt(row))
  }

  nextAttemptNo(taskId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE task_id = ?').get(taskId) as { n?: number } | undefined
    return Number(row?.n ?? 0) + 1
  }

  endAttempt(input: { attemptId: string; status: AttemptStatus; errorCode?: string | null; errorMessage?: string | null; recordPath?: string | null; now?: string }): void {
    const now = iso(input.now)
    this.db
      .prepare('UPDATE attempts SET status = ?, ended_at = ?, error_code = ?, error_message = ?, record_path = COALESCE(?, record_path) WHERE id = ?')
      .run(input.status, now, input.errorCode ?? null, input.errorMessage ?? null, input.recordPath ?? null, input.attemptId)
  }

  attachSessionToAttempt(attemptId: string, sessionId: string): void {
    this.db.prepare('UPDATE attempts SET session_id = ? WHERE id = ?').run(sessionId, attemptId)
  }

  attachRuntimeToAttempt(attemptId: string, runtimeId: string): void {
    this.db.prepare('UPDATE attempts SET runtime_id = ? WHERE id = ?').run(runtimeId, attemptId)
  }

  // ---------------------------------------------------------------- sessions

  upsertSession(input: { id: string; taskId: string; attemptId: string; runtimeId?: string | null; state: SessionState; lastError?: string | null; now?: string }): SessionRecord {
    const now = iso(input.now)
    const existing = this.getSession(input.id)
    if (existing) {
      this.db
        .prepare('UPDATE sessions SET state = ?, runtime_id = COALESCE(?, runtime_id), updated_at = ?, last_error = ? WHERE id = ?')
        .run(input.state, input.runtimeId ?? null, now, input.lastError ?? null, input.id)
    } else {
      this.db
        .prepare('INSERT INTO sessions (id, task_id, attempt_id, runtime_id, state, created_at, updated_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.id, input.taskId, input.attemptId, input.runtimeId ?? null, input.state, now, now, input.lastError ?? null)
    }
    return this.getSession(input.id) as SessionRecord
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      attemptId: String(row.attempt_id),
      runtimeId: row.runtime_id ? String(row.runtime_id) : null,
      state: String(row.state) as SessionState,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastError: row.last_error ? String(row.last_error) : null,
    }
  }

  listSessions(taskId: string): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      attemptId: String(row.attempt_id),
      runtimeId: row.runtime_id ? String(row.runtime_id) : null,
      state: String(row.state) as SessionState,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastError: row.last_error ? String(row.last_error) : null,
    }))
  }

  // ---------------------------------------------------------------- runtime records

  upsertRuntime(input: { id: string; isolation: TaskIsolation; pid: number | null; state: string; now?: string }): void {
    const now = iso(input.now)
    this.db
      .prepare('INSERT INTO runtimes (id, isolation, pid, state, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, state = excluded.state')
      .run(input.id, input.isolation, input.pid, input.state, now)
  }

  endRuntime(id: string, state: string, lastError?: string | null): void {
    this.db.prepare('UPDATE runtimes SET state = ?, ended_at = ?, last_error = ? WHERE id = ?').run(state, iso(), lastError ?? null, id)
  }

  // ---------------------------------------------------------------- verification & events

  recordVerification(input: { taskId: string; attemptId: string; ok: boolean; code?: string | null; detail?: string | null; now?: string }): VerificationRecord {
    const now = iso(input.now)
    const info = this.db
      .prepare('INSERT INTO verifications (task_id, attempt_id, ok, code, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.taskId, input.attemptId, input.ok ? 1 : 0, input.code ?? null, input.detail ?? null, now)
    return {
      id: Number(info.lastInsertRowid),
      taskId: input.taskId,
      attemptId: input.attemptId,
      ok: input.ok,
      code: input.code ?? null,
      detail: input.detail ?? null,
      at: now,
    }
  }

  listVerifications(taskId: string): VerificationRecord[] {
    const rows = this.db.prepare('SELECT * FROM verifications WHERE task_id = ? ORDER BY id ASC').all(taskId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      attemptId: String(row.attempt_id),
      ok: Number(row.ok) === 1,
      code: row.code ? String(row.code) : null,
      detail: row.detail ? String(row.detail) : null,
      at: String(row.at),
    }))
  }

  appendEvent(input: { taskId: string; attemptId?: string | null; kind: string; summary?: string | null; now?: string }): void {
    this.db
      .prepare('INSERT INTO events (task_id, attempt_id, kind, summary, at) VALUES (?, ?, ?, ?, ?)')
      .run(input.taskId, input.attemptId ?? null, input.kind, input.summary ?? null, iso(input.now))
  }

  listEvents(taskId: string, limit = 100): { id: number; kind: string; summary: string | null; at: string }[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit) as Record<string, unknown>[]
    return rows.map((row) => ({ id: Number(row.id), kind: String(row.kind), summary: row.summary ? String(row.summary) : null, at: String(row.at) }))
  }

  // ---------------------------------------------------------------- views

  getTaskView(id: string): TaskView | null {
    const task = this.getTask(id)
    if (!task) return null
    return {
      ...task,
      attempts: this.listAttempts(id),
      sessions: this.listSessions(id),
      transitions: this.listTransitions(id),
      verifications: this.listVerifications(id),
    }
  }

  /** Tasks that were mid-flight when the process stopped; used by crash recovery. */
  listUnfinished(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('QUEUED','PREPARING','RUNNING','INTERRUPTING','RESUMING','VERIFYING') ORDER BY updated_at ASC")
      .all() as Record<string, unknown>[]
    return rows.map((row) => this.#mapTask(row))
  }

  /** Exposed for tests and diagnostics: is this move legal from the stored state? */
  canMove(taskId: string, to: TaskStatus): boolean {
    const task = this.getTask(taskId)
    return task ? canTransition(task.status, to) : false
  }
}
