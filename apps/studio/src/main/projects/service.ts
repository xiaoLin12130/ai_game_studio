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
import { ProjectLocks } from './locks'
import { ProjectStore } from './store'
import { inspectProjectRoot, realPathOf } from './paths'
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
  #openProjectId: string | null = null

  constructor(options: ProjectServiceOptions) {
    this.store = new ProjectStore({ db: options.db })
    this.locks = new ProjectLocks(options.db)
    this.#logger = options.logger
    this.#dataDir = options.dataDir
    this.#now = options.now ?? (() => new Date())
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

  /** Absolute path of the app's own metadata directory for a project. */
  dataDirFor(projectId: string): string {
    return path.join(this.#dataDir, projectId)
  }

  /** Resolve a path the caller claims is inside the project, or throw. */
  resolveProjectPath(projectId: string, relative: string): string {
    const project = this.store.get(projectId)
    if (!project) throw new ProjectError('WRITE_FAILED', '项目不存在。', projectId)
    const root = realPathOf(project.rootPath)
    return path.resolve(root, relative)
  }
}
