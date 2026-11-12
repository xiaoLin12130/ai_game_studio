/**
 * How the task and project services are assembled.
 *
 * This lives outside main.ts so the production wiring can be tested directly. The previous
 * round's tests built their own TaskService with hand-injected dependencies, which proved
 * the lock worked but not that the app ever passed it one — and it did not.
 *
 * The ordering problem: TaskService needs a project lookup, ProjectService needs the task
 * store. The lookup is a closure over a variable filled in immediately after, and it refuses
 * rather than guessing while the project service does not exist yet.
 */
import { ProjectLocks } from './projects/locks'
import { AdvisorService } from './requirements/advisor'
import { AttachmentService } from './requirements/attachments'
import { BaselineService } from './requirements/baseline'
import { ContextCompiler } from './requirements/context'
import { ResearchService } from './requirements/research'
import { RequirementStore } from './requirements/store'
import { ProjectService } from './projects/service'
import { TaskService } from './tasks/service'
import { TaskStore } from './tasks/store'

export interface WiringLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface WiringOptions {
  logger: WiringLogger
  userDataDir: string
  dbPath: string
  dshHome: string
  profile: string
  provider: string
  model: string
  cwd: string
  entryPath?: string | null
  /** Test seam: supply an already-open store instead of opening one. */
  store?: TaskStore
  /** How long one attempt may run. */
  runTimeoutMs?: number
  /**
   * Test seam: build the runtime supervisor. Production leaves this out and TaskService
   * creates the real one; tests supply a stub so no runtime is spawned.
   */
  supervisorFactory?: (options: Record<string, unknown>) => unknown
}

export interface WiredApp {
  store: TaskStore
  tasks: TaskService
  projects: ProjectService
  locks: ProjectLocks
  requirements: RequirementStore
  advisor: AdvisorService
  attachments: AttachmentService
  baselines: BaselineService
  research: ResearchService
  ready(): boolean
  dispose(reason: string): Promise<{ closed: string[]; failed: string[]; ok: boolean }>
}

export class WiringError extends Error {
  constructor(message: string) {
    super('WIRING_NOT_READY: ' + message)
    this.name = 'WiringError'
  }
}

/**
 * Build the services the way the application does.
 *
 * Everything shares one SQLite connection and one lock table: a second database would make
 * the project/task foreign key unenforceable, and a second lock table would let two writers
 * into the same project.
 */
export function wireServices(options: WiringOptions): WiredApp {
  const store = options.store ?? new TaskStore(options.dbPath)
  const locks = new ProjectLocks(store.db)

  let projects: ProjectService | null = null
  let disposed = false

  const tasks = new TaskService({
    logger: options.logger,
    userDataDir: options.userDataDir,
    dshHome: options.dshHome,
    profile: options.profile,
    provider: options.provider,
    model: options.model,
    cwd: options.cwd,
    entryPath: options.entryPath ?? null,
    store,
    projectLocks: locks,
    projectExists: (projectId: string) => {
      if (!projects) throw new WiringError('project service is not ready yet')
      return Boolean(projects.store.get(projectId))
    },
    runTimeoutMs: options.runTimeoutMs,
    supervisor: options.supervisorFactory
      ? (options.supervisorFactory({}) as never)
      : undefined,
  })

  projects = new ProjectService({
    db: store.db,
    logger: options.logger,
    dataDir: options.userDataDir + '/project-data',
    dbPath: options.dbPath,
    hasActiveWork: () => tasks.runner.hasInFlightWork,
    // The restore copies rows inside a transaction, so the connection stays open and this
    // store remains its single owner. Verification reads the live file.
    reopenDatabase: () => ({
      db: store.db,
      verify: () => projects!.verifyLiveDatabase().ok,
    }),
  })

  // The requirement system shares the same connection and the same project boundary. It is
  // built after the project service because every one of its reads is project-scoped.
  const requirements = new RequirementStore(store.db)
  const compiler = new ContextCompiler()
  const attachments = new AttachmentService({ store: requirements, dataDir: options.userDataDir + '/attachments' })
  const advisor = new AdvisorService({
    store: requirements,
    supervisor: tasks.supervisor,
    compiler,
    attachments,
    logger: options.logger,
    projectExists: (projectId: string) => Boolean(projects!.store.get(projectId)),
    projectContext: (projectId: string) => {
      const project = projects!.store.get(projectId)
      const config = project ? projects!.store.getConfig(projectId) : null
      const settings = (config?.settings ?? {}) as Record<string, unknown>
      const facts = Array.isArray(settings.facts) ? (settings.facts as string[]) : []
      const openQuestions = Array.isArray(settings.openQuestions) ? (settings.openQuestions as string[]) : []
      return {
        facts,
        openQuestions,
        rules: project ? [{ title: '项目规则', content: '项目：' + project.name + '\n引擎：' + project.engine + '\n平台：' + project.platform }] : [],
      }
    },
  })
  const baselines = new BaselineService(requirements)
  const research = new ResearchService({
    store: requirements,
    logger: options.logger,
    runResearch: async () => ({ ok: false, markdown: '', sources: [], error: '研究执行器尚未接入。' }),
  })

  return {
    store,
    tasks,
    projects,
    locks,
    requirements,
    advisor,
    attachments,
    baselines,
    research,
    ready: () => projects !== null,
    async dispose(reason: string) {
      if (disposed) return { closed: [], failed: [], ok: true }
      disposed = true
      return tasks.dispose(reason)
    },
  }
}
