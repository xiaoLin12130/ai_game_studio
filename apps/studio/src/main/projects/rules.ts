/**
 * Project rules and state, read through a controlled service.
 *
 * The renderer never touches the filesystem. It asks for a named rule source and gets text
 * back, or an error that says why. Every read is bounded: a fixed list of known files, a
 * size cap, and a path check against the project root for anything project-scoped.
 *
 * This is deliberately not a prompt compiler or a RAG index. It answers "what rules apply
 * to this project, and what state is it in" — nothing more.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assertInsideProject } from './paths'

export type RuleScope = 'global' | 'project'

export interface RuleSource {
  id: string
  scope: RuleScope
  /** Path relative to the repository root (global) or the project root (project). */
  relativePath: string
  title: string
  description: string
}

export interface RuleDocument {
  id: string
  scope: RuleScope
  title: string
  path: string
  exists: boolean
  bytes: number
  /** Truncated to MAX_BYTES; the UI shows a notice when this is true. */
  truncated: boolean
  content: string | null
  error: string | null
}

/** The files this app treats as rules. A fixed list, not a directory walk. */
export const RULE_SOURCES: readonly RuleSource[] = [
  { id: 'agents', scope: 'global', relativePath: 'AGENTS.md', title: '全局工作规则', description: '所有阶段都必须遵守的 Agent 纪律' },
  { id: 'readme', scope: 'global', relativePath: 'README.md', title: '项目说明', description: '安装、启动与仓库结构' },
  { id: 'handoff', scope: 'global', relativePath: 'memory-bank/handoff.md', title: '阶段交接', description: '各阶段的完成状态与遗留项' },
  { id: 'decisions', scope: 'global', relativePath: 'memory-bank/decisions.md', title: '决策记录', description: '已作出的技术决策' },
  { id: 'lessons', scope: 'global', relativePath: 'memory-bank/lessons.md', title: '经验教训', description: '踩过的坑与处理方式' },
  { id: 'project-state', scope: 'global', relativePath: 'state/project_state.json', title: '项目状态', description: '当前阶段与关闭状态' },
  { id: 'project-agents', scope: 'project', relativePath: 'AGENTS.md', title: '项目规则', description: '该项目自己的 Agent 规则（可选）' },
  { id: 'project-readme', scope: 'project', relativePath: 'README.md', title: '项目说明', description: '该项目自己的说明（可选）' },
]

const MAX_BYTES = 64 * 1024

export interface RulesOptions {
  /** Repository root, for global rules. */
  repoRoot: string
  /** Current project root, or null when no project is open. */
  projectRoot: string | null
}

export class RulesService {
  #options: RulesOptions

  constructor(options: RulesOptions) {
    this.#options = options
  }

  setProjectRoot(root: string | null): void {
    this.#options = { ...this.#options, projectRoot: root }
  }

  list(): RuleSource[] {
    return [...RULE_SOURCES]
  }

  /** Read one rule document. Never throws: a missing file is a result, not an exception. */
  read(id: string): RuleDocument {
    const source = RULE_SOURCES.find((entry) => entry.id === id)
    if (!source) {
      return { id, scope: 'global', title: id, path: '', exists: false, bytes: 0, truncated: false, content: null, error: 'UNKNOWN_SOURCE: 没有这个规则来源。' }
    }

    const base = source.scope === 'global' ? this.#options.repoRoot : this.#options.projectRoot
    if (!base) {
      return { id, scope: source.scope, title: source.title, path: '', exists: false, bytes: 0, truncated: false, content: null, error: 'NO_PROJECT: 当前没有打开的项目。' }
    }

    let absolute: string
    try {
      absolute = path.resolve(base, source.relativePath)
      // Project rules must stay inside the project; a rule file is still a file read.
      if (source.scope === 'project') assertInsideProject(base, absolute)
    } catch (error) {
      return { id, scope: source.scope, title: source.title, path: '', exists: false, bytes: 0, truncated: false, content: null, error: String((error as Error)?.message ?? error) }
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(absolute)
    } catch {
      return { id, scope: source.scope, title: source.title, path: absolute, exists: false, bytes: 0, truncated: false, content: null, error: null }
    }
    if (!stat.isFile()) {
      return { id, scope: source.scope, title: source.title, path: absolute, exists: false, bytes: 0, truncated: false, content: null, error: 'NOT_A_FILE: 该路径不是文件。' }
    }

    try {
      const buffer = fs.readFileSync(absolute)
      const truncated = buffer.length > MAX_BYTES
      const content = buffer.subarray(0, MAX_BYTES).toString('utf8')
      return { id, scope: source.scope, title: source.title, path: absolute, exists: true, bytes: buffer.length, truncated, content, error: null }
    } catch (error) {
      return { id, scope: source.scope, title: source.title, path: absolute, exists: true, bytes: stat.size, truncated: false, content: null, error: String((error as Error)?.message ?? error) }
    }
  }

  /** Read every source; used by the rules page. */
  readAll(): RuleDocument[] {
    return RULE_SOURCES.map((source) => this.read(source.id))
  }

  /**
   * The project's phase and status, read from the state file.
   *
   * Returns null rather than guessing when the file is missing or malformed: a wrong phase
   * shown to the user is worse than no phase.
   */
  projectState(): { phase: string | null; status: string | null; raw: string | null; error: string | null } {
    const doc = this.read('project-state')
    if (!doc.exists || !doc.content) return { phase: null, status: null, raw: null, error: doc.error ?? 'state file is missing' }
    try {
      const parsed = JSON.parse(doc.content) as Record<string, unknown>
      return {
        phase: typeof parsed.current_phase === 'string' ? parsed.current_phase : typeof parsed.phase === 'string' ? parsed.phase : null,
        status: typeof parsed.status === 'string' ? parsed.status : null,
        raw: doc.content,
        error: null,
      }
    } catch (error) {
      return { phase: null, status: null, raw: doc.content, error: 'state file is not valid JSON: ' + String((error as Error)?.message ?? error) }
    }
  }
}
