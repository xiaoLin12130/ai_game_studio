/**
 * Project lifecycle: create, open, close, configure.
 *
 * The rules this file enforces, in order of how much damage getting them wrong would do:
 *
 *   1. Never write into a directory that already holds something. Creating a project in a
 *      non-empty folder is how a user loses work they did not back up.
 *   2. Two projects may not share a root. The root is the isolation boundary; sharing it
 *      would make "project A cannot touch project B" false by construction.
 *   3. Closing a project never deletes tasks or sessions. The history of what was attempted
 *      belongs to the project record.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createBackup as writeBackupFile, restoreBackup as replaceDatabase, readTables, verifyDatabase, REQUIRED_TABLES, SCHEMA_VERSION_MIN, SCHEMA_VERSION_MAX } from './backup'
import { ProjectLocks } from './locks'
import { ProjectStore } from './store'
import { assertInsideProject, inspectProjectRoot, realPathOf } from './paths'
import {
  SUPPORTED_ENGINES,
  SUPPORTED_PLATFORMS,
  type CreateProjectInput,
  type EngineId,
  type PlatformId,
  type ProjectRecord,
  type ProjectView,
} from './types'

export interface ProjectLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export type CreateFailure =
  | 'INVALID_NAME'
  | 'UNSUPPORTED_ENGINE'
  | 'UNSUPPORTED_PLATFORM'
  | 'ROOT_UNUSABLE'
  | 'ROOT_NOT_EMPTY'
  | 'ROOT_ALREADY_USED'
  | 'WRITE_FAILED'

export class ProjectError extends Error {
  readonly code: CreateFailure
  readonly detail: string

  constructor(code: CreateFailure, message: string, detail = '') {
    super(`${code}: ${message}`)
    this.name = 'ProjectError'
    this.code = code
    this.detail = detail
  }
}

export interface ProjectServiceOptions {
  db: DatabaseSync
  logger: ProjectLogger
  /** Where the app keeps its own per-project metadata (not the user's game files). */
  dataDir: string
  now?: () => Date
  /** Absolute path of the live database file, needed for backup and restore. */
  dbPath?: string
  /**
   * Close and reopen the live connection around a restore.
   *
   * Restoring copies a file over the database, which cannot be done while a connection
   * holds it. The owner of the connection supplies this so the service never guesses.
   */
  reopenDatabase?: () => { db: DatabaseSync; verify: () => boolean }
  /** Close the live connection; called before a restore replaces the file. */
  closeDatabase?: () => void
  /** Refuses a restore while work is in flight. */
  hasActiveWork?: () => boolean
}

export interface BackupInfo {
  file: string
  bytes: number
  createdAt: string
}

export interface BackupOutcome {
  ok: boolean
  file: string | null
  bytes: number
  error: string | null
}

export interface RestoreOutcome {
  ok: boolean
  file: string | null
  safetyCopy: string | null
  verified: boolean
  error: string | null
}

const NAME_MAX = 60
/** Characters Windows forbids in a directory name, plus control characters. */
const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f]/

export function validateProjectName(name: string): { ok: boolean; reason: string } {
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, reason: '项目名称不能为空。' }
  if (trimmed.length > NAME_MAX) return { ok: false, reason: `项目名称不能超过 ${NAME_MAX} 个字符。` }
  if (ILLEGAL_NAME.test(trimmed)) return { ok: false, reason: '项目名称不能包含 < > : " / \\ | ? * 等字符。' }
  if (trimmed === '.' || trimmed === '..') return { ok: false, reason: '项目名称不能是 . 或 ..。' }
  if (/[. ]$/.test(trimmed)) return { ok: false, reason: '项目名称不能以空格或句点结尾。' }
  return { ok: true, reason: '' }
}

export class ProjectService {
  readonly store: ProjectStore
  readonly locks: ProjectLocks
  readonly #logger: ProjectLogger
  readonly #dataDir: string
  readonly #now: () => Date
  readonly #dbPath: string | null
  readonly #reopenDatabase: (() => { db: DatabaseSync; verify: () => boolean }) | null
  readonly #closeDatabase: () => void
  readonly #hasActiveWork: () => boolean
  #openProjectId: string | null = null

  constructor(options: ProjectServiceOptions) {
    this.store = new ProjectStore({ db: options.db })
    this.locks = new ProjectLocks(options.db)
    this.#logger = options.logger
    this.#dataDir = options.dataDir
    this.#now = options.now ?? (() => new Date())
    this.#dbPath = options.dbPath ?? null
    this.#reopenDatabase = options.reopenDatabase ?? null
    this.#closeDatabase = options.closeDatabase ?? (() => {})
    this.#hasActiveWork = options.hasActiveWork ?? (() => false)
    fs.mkdirSync(this.#dataDir, { recursive: true })
  }

  get openProject(): string | null {
    return this.#openProjectId
  }

  list(): ProjectRecord[] {
    return this.store.list()
  }

  view(id: string): ProjectView | null {
    return this.store.view(id)
  }

  /**
   * Create a project.
   *
   * The directory must exist, be writable, and be empty. An empty directory is adopted; a
   * non-empty one is refused rather than written into, because the app cannot know whether
   * its contents matter.
   */
  create(input: CreateProjectInput): ProjectRecord {
    const nameCheck = validateProjectName(input.name)
    if (!nameCheck.ok) throw new ProjectError('INVALID_NAME', nameCheck.reason)

    if (!SUPPORTED_ENGINES.includes(input.engine)) {
      throw new ProjectError('UNSUPPORTED_ENGINE', '当前版本只支持 Cocos Creator 3.8.6。', String(input.engine))
    }
    if (!SUPPORTED_PLATFORMS.includes(input.platform)) {
      throw new ProjectError('UNSUPPORTED_PLATFORM', '当前版本只支持微信小游戏。', String(input.platform))
    }

    const inspected = inspectProjectRoot(input.rootPath)
    if (!inspected.ok || !inspected.resolved) {
      throw new ProjectError('ROOT_UNUSABLE', inspected.detail, inspected.code)
    }
    const rootPath = inspected.resolved

    const existing = this.store.findByRoot(rootPath)
    if (existing) {
      throw new ProjectError('ROOT_ALREADY_USED', '该目录已经是另一个项目的根目录。', existing.name)
    }

    let entries: string[]
    try {
      entries = fs.readdirSync(rootPath)
    } catch (error) {
      throw new ProjectError('ROOT_UNUSABLE', '无法读取该目录。', String((error as Error)?.message ?? error))
    }
    if (entries.length > 0) {
      throw new ProjectError('ROOT_NOT_EMPTY', '该目录不是空目录，为避免覆盖已有文件，请选择一个空目录。', entries.slice(0, 5).join(', '))
    }

    const id = 'proj-' + crypto.randomUUID().slice(0, 8)
    const now = this.#now().toISOString()
    let project: ProjectRecord
    try {
      project = this.store.create({ id, name: input.name.trim(), rootPath, engine: input.engine, platform: input.platform, now })
    } catch (error) {
      throw new ProjectError('WRITE_FAILED', '保存项目失败。', String((error as Error)?.message ?? error))
    }

    // A small marker so the directory is recognisable as a Studio project, written only
    // after the row exists: a failed insert must not leave a half-created project on disk.
    try {
      fs.writeFileSync(
        path.join(rootPath, '.studio-project.json'),
        JSON.stringify({ id: project.id, name: project.name, engine: project.engine, platform: project.platform, createdAt: project.createdAt }, null, 2) + '\n',
        'utf8',
      )
    } catch (error) {
      this.#logger.warn('project.marker.failed', { projectId: project.id, error: String((error as Error)?.message ?? error) })
    }

    this.#logger.info('project.created', { projectId: project.id, engine: project.engine, platform: project.platform })
    return project
  }

  /** Open a project: verify the root still exists, then record the open. */
  open(id: string): ProjectRecord {
    const project = this.store.get(id)
    if (!project) throw new ProjectError('WRITE_FAILED', '项目不存在。', id)

    const inspected = inspectProjectRoot(project.rootPath)
    if (!inspected.ok) {
      throw new ProjectError('ROOT_UNUSABLE', '项目目录不可用：' + inspected.detail, inspected.code)
    }
    if (inspected.resolved !== project.rootPath) {
      // The directory was moved or a junction now points elsewhere; refuse rather than
      // silently operating on a different location.
      throw new ProjectError('ROOT_UNUSABLE', '项目目录位置已改变，请重新创建或修正路径。', String(inspected.resolved))
    }

    this.store.touchOpened(id, this.#now().toISOString())
    this.#openProjectId = id
    this.#logger.info('project.opened', { projectId: id })
    return this.store.get(id) as ProjectRecord
  }

  /** Close the open project. Tasks and sessions are untouched by design. */
  close(id: string): void {
    const project = this.store.get(id)
    if (!project) throw new ProjectError('WRITE_FAILED', '项目不存在。', id)
    this.store.recordClosed(id, this.#now().toISOString())
    if (this.#openProjectId === id) this.#openProjectId = null
    this.#logger.info('project.closed', { projectId: id })
  }

  updateConfig(id: string, settings: Record<string, unknown>): void {
    const project = this.store.get(id)
    if (!project) throw new ProjectError('WRITE_FAILED', '项目不存在。', id)
    this.store.updateConfig(id, settings, this.#now().toISOString())
    this.#logger.info('project.config.updated', { projectId: id, keys: Object.keys(settings) })
  }

  /** Where this project's backups live. A stable, recognisable location. */
  backupDirFor(projectId: string): string {
    return path.join(this.#dataDir, projectId, 'backups')
  }

  listBackups(projectId: string): BackupInfo[] {
    const dir = this.backupDirFor(projectId)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => {
        const file = path.join(dir, name)
        const stat = fs.statSync(file)
        return { file, bytes: stat.size, createdAt: stat.mtime.toISOString() }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Back up the whole studio database.
   *
   * VACUUM INTO takes a consistent snapshot while the connection is open, which a plain
   * file copy cannot promise under WAL.
   */
  createBackup(projectId: string): BackupOutcome {
    const project = this.store.get(projectId)
    if (!project) return { ok: false, file: null, bytes: 0, error: '项目不存在。' }
    if (!this.#dbPath) return { ok: false, file: null, bytes: 0, error: '当前运行没有可备份的数据库路径。' }

    const stamp = this.#now().toISOString().replace(/[:.]/g, '-')
    const target = path.join(this.backupDirFor(projectId), `studio-${stamp}.db`)
    const result = writeBackupFile(this.#dbPath, target)
    if (!result.ok) {
      this.#logger.error('project.backup.failed', { projectId, error: result.error })
      return { ok: false, file: null, bytes: 0, error: result.error ?? '备份失败。' }
    }
    this.store.appendEvent(projectId, 'project.backup.created', path.basename(target), this.#now().toISOString())
    this.#logger.info('project.backup.created', { projectId, file: path.basename(target), bytes: result.bytes })
    return { ok: true, file: target, bytes: result.bytes, error: null }
  }

  /**
   * Restore the studio database from a backup.
   *
   * Refused while work is in flight: overwriting the database under a running task would
   * corrupt both. The connection is closed, the file replaced, the connection reopened, and
   * the result verified by reading through the normal store — a restore that cannot be read
   * back is reported as a failure, not as success.
   */
  restoreBackup(projectId: string, backupFile: string): RestoreOutcome {
    // Deliberately no "does this project exist" check: restoring is how a user recovers a
    // project they deleted or that a bad migration removed. The project id only decides
    // where the backup and safety copy are filed.
    if (!projectId || projectId.trim().length === 0) {
      return { ok: false, file: null, safetyCopy: null, verified: false, error: '缺少项目标识。' }
    }
    if (!this.#dbPath || !this.#reopenDatabase) {
      return { ok: false, file: null, safetyCopy: null, verified: false, error: '当前运行不支持在线恢复。' }
    }
    if (this.#hasActiveWork()) {
      return { ok: false, file: null, safetyCopy: null, verified: false, error: '有任务正在执行，请先停止后再恢复。' }
    }
    if (!fs.existsSync(backupFile)) {
      return { ok: false, file: null, safetyCopy: null, verified: false, error: '备份文件不存在。' }
    }
    // Pre-flight. Nothing has been touched yet, so no safety copy is needed; a backup that
    // cannot even be opened, or that is missing tables, is refused here rather than after
    // the current data has been partly overwritten.
    let backupTables: string[]
    try {
      backupTables = readTables(backupFile)
    } catch {
      return { ok: false, file: null, safetyCopy: null, verified: false, error: '该文件不是可用的数据库备份。' }
    }
    const absent = REQUIRED_TABLES.filter((name) => !backupTables.includes(name))
    if (absent.length > 0) {
      return { ok: false, file: null, safetyCopy: null, verified: false, error: '该备份不完整，缺少表：' + absent.join(', ') }
    }

    const safety = path.join(this.backupDirFor(projectId), `pre-restore-${this.#now().toISOString().replace(/[:.]/g, '-')}.db`)
    const result = replaceDatabase(this.#dbPath, backupFile, safety)
    if (!result.ok) {
      this.#logger.error('project.restore.failed', { projectId, error: result.error })
      return { ok: false, file: backupFile, safetyCopy: result.safetyCopy, verified: false, error: result.error ?? '恢复失败。' }
    }

    // The rows were copied inside a transaction, so the connection is still valid; the
    // check below reads the live database rather than trusting the copy.
    let verified = false
    let detail = ''
    try {
      const reopened = this.#reopenDatabase()
      verified = reopened.verify()
      if (!verified) detail = '数据校验未通过'
    } catch (error) {
      this.#logger.error('project.restore.reopen-failed', { projectId, error: String((error as Error)?.message ?? error) })
      return { ok: false, file: backupFile, safetyCopy: result.safetyCopy, verified: false, error: '恢复后无法重新打开数据库：' + String((error as Error)?.message ?? error) }
    }
    if (!verified) {
      return { ok: false, file: backupFile, safetyCopy: result.safetyCopy, verified: false, error: '恢复后的数据校验未通过：' + detail }
    }
    this.#logger.info('project.restore.completed', { projectId, file: path.basename(backupFile), safety: path.basename(safety) })
    return { ok: true, file: backupFile, safetyCopy: result.safetyCopy, verified: true, error: null }
  }

  /** Verify the live database the way a restore must: tables, integrity, foreign keys, version. */
  verifyLiveDatabase(): ReturnType<typeof verifyDatabase> {
    if (!this.#dbPath) {
      return { ok: false, tables: [], missingTables: [], integrity: 'no database path', foreignKeyViolations: -1, schemaVersion: -1, error: 'no database path' }
    }
    return verifyDatabase(this.#dbPath, [...REQUIRED_TABLES], SCHEMA_VERSION_MAX)
  }

  /** Absolute path of the app's own metadata directory for a project. */
  dataDirFor(projectId: string): string {
    return path.join(this.#dataDir, projectId)
  }

  /**
   * Resolve a path the caller claims is inside the project.
   *
   * This is the single entry point for project-scoped file access, so the containment
   * check lives here rather than at each call site: a bare path.resolve() would happily
   * return "C:\\games\\proj\\..\\..\\Windows" and every caller would have to remember to
   * check. The check resolves both sides to their real path, so a junction that points
   * outside is caught too.
   */
  resolveProjectPath(projectId: string, relative: string): string {
    const project = this.store.get(projectId)
    if (!project) throw new ProjectError('WRITE_FAILED', '项目不存在。', projectId)
    const root = realPathOf(project.rootPath)
    // An empty path resolves to the root itself, which is "inside" and therefore passes a
    // naive check. It is not a file the caller asked for, so it is refused explicitly.
    if (typeof relative !== 'string' || relative.trim().length === 0) {
      throw new ProjectError('WRITE_FAILED', 'EMPTY: 没有给出路径。', projectId)
    }
    const candidate = path.isAbsolute(relative) ? relative : path.resolve(root, relative)
    return assertInsideProject(root, candidate)
  }
}
