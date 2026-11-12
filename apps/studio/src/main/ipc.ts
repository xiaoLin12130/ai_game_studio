/**
 * The only channels the renderer can use.
 *
 * The renderer gets no filesystem, no child-process and no SDK access: every capability
 * is a named handler here, so adding one is a deliberate edit rather than an accident.
 */
import { ipcMain, shell, app } from 'electron'
import type { DshConnectionService } from './dsh/service'
import type { TaskService, CreateTaskRequest } from './tasks/service'
import type { ProjectService } from './projects/service'
import type { RulesService } from './projects/rules'
import type { CreateProjectInput } from './projects/types'
import type { TaskAction } from './tasks/types'
import type { Logger } from './logger'

export const CHANNELS = {
  getState: 'studio:get-state',
  recheck: 'studio:recheck',
  openLogs: 'studio:open-logs',
  getDiagnostics: 'studio:get-diagnostics',
  stateChanged: 'studio:state-changed',
  tasksList: 'studio:tasks:list',
  taskCreate: 'studio:tasks:create',
  taskGet: 'studio:tasks:get',
  taskAct: 'studio:tasks:act',
  tasksChanged: 'studio:tasks:changed',
  projectsList: 'studio:projects:list',
  projectCreate: 'studio:projects:create',
  projectOpen: 'studio:projects:open',
  projectClose: 'studio:projects:close',
  projectGet: 'studio:projects:get',
  projectUpdateConfig: 'studio:projects:config',
  projectBackup: 'studio:projects:backup',
  projectRestore: 'studio:projects:restore',
  projectBackups: 'studio:projects:backups',
  rulesList: 'studio:rules:list',
  rulesRead: 'studio:rules:read',
  rulesState: 'studio:rules:state',
  projectsChanged: 'studio:projects:changed',
} as const

export interface IpcDeps {
  service: DshConnectionService
  tasks: TaskService
  projects: ProjectService
  rules: RulesService
  logger: Logger
  logDir: string
  configPath: string
  userDataDir: string
  onRecheck: () => void
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle(CHANNELS.getState, () => deps.service.getState())

  ipcMain.handle(CHANNELS.recheck, () => {
    deps.logger.info('ui.recheck.requested', {})
    deps.onRecheck()
    return deps.service.getState()
  })

  ipcMain.handle(CHANNELS.getDiagnostics, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userDataDir: deps.userDataDir,
    configPath: deps.configPath,
    logPath: deps.logger.path,
    logDir: deps.logDir,
    state: deps.service.getState(),
  }))

  ipcMain.handle(CHANNELS.tasksList, () => deps.tasks.list())

  ipcMain.handle(CHANNELS.taskCreate, (_event, request: CreateTaskRequest) => {
    if (!request || typeof request.title !== 'string' || typeof request.goal !== 'string') {
      throw new Error('a task needs a title and a goal')
    }
    // The renderer may propose a project, but the main process decides whether it exists:
    // a forged id must not become a task that holds a lock on a row that is not there.
    if (request.projectId !== undefined && request.projectId !== null) {
      if (typeof request.projectId !== 'string' || request.projectId.trim().length === 0) {
        throw new Error('invalid project id')
      }
      if (!deps.projects.store.get(request.projectId)) {
        throw new Error('unknown project: ' + request.projectId)
      }
    }
    if (request.title.trim().length === 0 || request.goal.trim().length === 0) {
      throw new Error('a task needs a non-empty title and goal')
    }
    return deps.tasks.create(request)
  })

  ipcMain.handle(CHANNELS.taskGet, (_event, id: string) => deps.tasks.get(String(id)))

  ipcMain.handle(CHANNELS.taskAct, async (_event, payload: { id: string; action: TaskAction }) => {
    if (!payload || typeof payload.id !== 'string') throw new Error('missing task id')
    deps.logger.info('ui.task.act', { taskId: payload.id, action: payload.action })
    const task = await deps.tasks.act(payload.id, payload.action)
    return { task, runtimes: deps.tasks.runtimes() }
  })

  ipcMain.handle(CHANNELS.projectsList, () => deps.projects.list())

  ipcMain.handle(CHANNELS.projectCreate, (_event, input: CreateProjectInput) => {
    if (!input || typeof input.name !== 'string' || typeof input.rootPath !== 'string') {
      throw new Error('a project needs a name and a directory')
    }
    const project = deps.projects.create(input)
    deps.rules.setProjectRoot(project.rootPath)
    return project
  })

  ipcMain.handle(CHANNELS.projectOpen, (_event, id: string) => {
    const project = deps.projects.open(String(id))
    deps.rules.setProjectRoot(project.rootPath)
    return project
  })

  ipcMain.handle(CHANNELS.projectClose, (_event, id: string) => {
    deps.projects.close(String(id))
    deps.rules.setProjectRoot(null)
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.projectGet, (_event, id: string) => deps.projects.view(String(id)))

  ipcMain.handle(CHANNELS.projectUpdateConfig, (_event, payload: { id: string; settings: Record<string, unknown> }) => {
    deps.projects.updateConfig(String(payload.id), payload.settings ?? {})
    return deps.projects.view(String(payload.id))
  })

  ipcMain.handle(CHANNELS.projectBackup, (_event, id: string) => {
    deps.logger.info('ui.project.backup', { projectId: String(id) })
    return deps.projects.createBackup(String(id))
  })

  ipcMain.handle(CHANNELS.projectBackups, (_event, id: string) => deps.projects.listBackups(String(id)))

  ipcMain.handle(CHANNELS.projectRestore, (_event, payload: { id: string; file: string }) => {
    deps.logger.info('ui.project.restore', { projectId: String(payload?.id), file: String(payload?.file) })
    return deps.projects.restoreBackup(String(payload.id), String(payload.file))
  })

  ipcMain.handle(CHANNELS.rulesList, () => deps.rules.list())
  ipcMain.handle(CHANNELS.rulesRead, (_event, id: string) => deps.rules.read(String(id)))
  ipcMain.handle(CHANNELS.rulesState, () => deps.rules.projectState())

  ipcMain.handle(CHANNELS.openLogs, async () => {
    const error = await shell.openPath(deps.logDir)
    if (error) {
      deps.logger.warn('ui.open-logs.failed', { error })
      return { ok: false, error }
    }
    return { ok: true }
  })
}
