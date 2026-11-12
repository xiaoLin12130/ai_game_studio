/**
 * Project write lock and build lock.
 *
 * Three different mutual exclusions exist in this app and they are not the same thing:
 *
 *   TaskRunner single-flight  — one execution per task (PHASE 01-C)
 *   Runtime lease             — one runtime per writable task (PHASE 01-C)
 *   Project write lock        — one writer per *project* (this file)
 *   Build lock                — one build per project, excluding writers (this file)
 *
 * A task can be the only task running and still be the second writer on a project, which is
 * why the project lock cannot be derived from the task one.
 *
 * Locks are rows, not files. A file that exists is not proof that its owner is alive, and
 * "the file is there so the project is busy" is how a crashed run locks a project forever.
 * Each lock records its owner and heartbeat; a lock whose owner is gone is reclaimable.
 */
import type { DatabaseSync } from 'node:sqlite'

export type LockKind = 'write' | 'build'

export interface LockRecord {
  projectId: string
  kind: LockKind
  ownerId: string
  /** PID of the process holding it, so a dead owner can be detected. */
  ownerPid: number
  acquiredAt: string
  heartbeatAt: string
}

export type LockFailure =
  | 'HELD_BY_OTHER'
  | 'BUILD_IN_PROGRESS'
  | 'WRITER_ACTIVE'
  | 'NOT_OWNER'
  | 'UNKNOWN'

export class LockError extends Error {
  readonly code: LockFailure
  readonly holder: LockRecord | null

  constructor(code: LockFailure, message: string, holder: LockRecord | null = null) {
    // The code is part of the message: a log line or a test that only sees the text still
    // knows which failure it was.
    super(`${code}: ${message}`)
    this.name = 'LockError'
    this.code = code
    this.holder = holder
  }
}

export interface LockOptions {
  /** A lock older than this with no heartbeat is considered abandoned. */
  staleAfterMs?: number
  /** How to tell whether a PID is still alive; injectable for tests. */
  isProcessAlive?: (pid: number) => boolean
  now?: () => number
}

const DEFAULT_STALE_MS = 10 * 60 * 1000

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export class ProjectLocks {
  readonly #db: DatabaseSync
  readonly #options: Required<Pick<LockOptions, 'staleAfterMs' | 'isProcessAlive'>> & { now: () => number }

  constructor(db: DatabaseSync, options: LockOptions = {}) {
    this.#db = db
    this.#options = {
      staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_MS,
      isProcessAlive: options.isProcessAlive ?? defaultIsAlive,
      now: options.now ?? (() => Date.now()),
    }
  }

  #read(projectId: string, kind: LockKind): LockRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM project_locks WHERE project_id = ? AND kind = ?')
      .get(projectId, kind) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      projectId: String(row.project_id),
      kind: String(row.kind) as LockKind,
      ownerId: String(row.owner_id),
      ownerPid: Number(row.owner_pid),
      acquiredAt: String(row.acquired_at),
      heartbeatAt: String(row.heartbeat_at),
    }
  }

  /** A lock is stale when its owner process is gone, or it stopped heartbeating. */
  isStale(lock: LockRecord): boolean {
    if (!this.#options.isProcessAlive(lock.ownerPid)) return true
    const age = this.#options.now() - Date.parse(lock.heartbeatAt)
    return Number.isFinite(age) && age > this.#options.staleAfterMs
  }

  /** Drop a stale lock so the next caller can take it. Returns true when something was freed. */
  reclaimStale(projectId: string): boolean {
    let freed = false
    for (const kind of ['write', 'build'] as LockKind[]) {
      const lock = this.#read(projectId, kind)
      if (lock && this.isStale(lock)) {
        this.#db.prepare('DELETE FROM project_locks WHERE project_id = ? AND kind = ?').run(projectId, kind)
        freed = true
      }
    }
    return freed
  }

  current(projectId: string): { write: LockRecord | null; build: LockRecord | null } {
    return { write: this.#read(projectId, 'write'), build: this.#read(projectId, 'build') }
  }

  /**
   * Take the write lock.
   *
   * Refused when another live owner holds it, or when a build is running: a build reads the
   * inputs a writer would change, so they cannot overlap.
   */
  acquireWrite(projectId: string, ownerId: string, ownerPid = process.pid): LockRecord {
    return this.#acquire(projectId, 'write', ownerId, ownerPid)
  }

  /** Take the build lock. Refused when a writer or another build holds the project. */
  acquireBuild(projectId: string, ownerId: string, ownerPid = process.pid): LockRecord {
    return this.#acquire(projectId, 'build', ownerId, ownerPid)
  }

  #acquire(projectId: string, kind: LockKind, ownerId: string, ownerPid: number): LockRecord {
    this.reclaimStale(projectId)
    const now = new Date(this.#options.now()).toISOString()
    return (() => {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        const write = this.#read(projectId, 'write')
        const build = this.#read(projectId, 'build')

        if (kind === 'write') {
          if (write && write.ownerId !== ownerId) {
            throw new LockError('HELD_BY_OTHER', 'another task is already writing to this project', write)
          }
          if (build) {
            throw new LockError('BUILD_IN_PROGRESS', 'a build is running; writing is not allowed until it finishes', build)
          }
        } else {
          if (build && build.ownerId !== ownerId) {
            throw new LockError('HELD_BY_OTHER', 'another build is already running for this project', build)
          }
          if (write) {
            throw new LockError('WRITER_ACTIVE', 'a task is writing to this project; a build cannot start', write)
          }
        }

        this.#db
          .prepare(
            `INSERT INTO project_locks (project_id, kind, owner_id, owner_pid, acquired_at, heartbeat_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, kind) DO UPDATE SET owner_id = excluded.owner_id, owner_pid = excluded.owner_pid, heartbeat_at = excluded.heartbeat_at`,
          )
          .run(projectId, kind, ownerId, ownerPid, now, now)
        this.#db.exec('COMMIT')
        return this.#read(projectId, kind) as LockRecord
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    })()
  }

  /** Refresh the heartbeat so a long operation is not mistaken for an abandoned one. */
  heartbeat(projectId: string, kind: LockKind, ownerId: string): void {
    const lock = this.#read(projectId, kind)
    if (!lock || lock.ownerId !== ownerId) {
      throw new LockError('NOT_OWNER', 'this owner does not hold the lock', lock)
    }
    this.#db
      .prepare('UPDATE project_locks SET heartbeat_at = ? WHERE project_id = ? AND kind = ?')
      .run(new Date(this.#options.now()).toISOString(), projectId, kind)
  }

  /** Release a lock. Only the owner may release it, so one task cannot free another's lock. */
  release(projectId: string, kind: LockKind, ownerId: string): void {
    const lock = this.#read(projectId, kind)
    if (!lock) return
    if (lock.ownerId !== ownerId) {
      throw new LockError('NOT_OWNER', 'only the owner can release this lock', lock)
    }
    this.#db.prepare('DELETE FROM project_locks WHERE project_id = ? AND kind = ?').run(projectId, kind)
  }

  /** Release everything a process held; used on shutdown. */
  releaseAllFor(ownerPid: number): number {
    const info = this.#db.prepare('DELETE FROM project_locks WHERE owner_pid = ?').run(ownerPid)
    return Number(info.changes ?? 0)
  }

  list(): LockRecord[] {
    const rows = this.#db.prepare('SELECT * FROM project_locks').all() as Record<string, unknown>[]
    return rows.map((row) => ({
      projectId: String(row.project_id),
      kind: String(row.kind) as LockKind,
      ownerId: String(row.owner_id),
      ownerPid: Number(row.owner_pid),
      acquiredAt: String(row.acquired_at),
      heartbeatAt: String(row.heartbeat_at),
    }))
  }
}
