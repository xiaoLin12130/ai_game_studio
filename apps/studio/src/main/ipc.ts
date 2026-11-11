/**
 * The only channels the renderer can use.
 *
 * The renderer gets no filesystem, no child-process and no SDK access: every capability
 * is a named handler here, so adding one is a deliberate edit rather than an accident.
 */
import { ipcMain, shell, app } from 'electron'
import type { DshConnectionService } from './dsh/service'
import type { TaskService, CreateTaskRequest } from './tasks/service'
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
} as const

export interface IpcDeps {
  service: DshConnectionService
  tasks: TaskService
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

  ipcMain.handle(CHANNELS.openLogs, async () => {
    const error = await shell.openPath(deps.logDir)
    if (error) {
      deps.logger.warn('ui.open-logs.failed', { error })
      return { ok: false, error }
    }
    return { ok: true }
  })
}
