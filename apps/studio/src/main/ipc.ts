/**
 * The only channels the renderer can use.
 *
 * The renderer gets no filesystem, no child-process and no SDK access: every capability
 * is a named handler here, so adding one is a deliberate edit rather than an accident.
 */
import { ipcMain, shell, app } from 'electron'
import type { DshConnectionService } from './dsh/service'
import type { Logger } from './logger'

export const CHANNELS = {
  getState: 'studio:get-state',
  recheck: 'studio:recheck',
  openLogs: 'studio:open-logs',
  getDiagnostics: 'studio:get-diagnostics',
  stateChanged: 'studio:state-changed',
} as const

export interface IpcDeps {
  service: DshConnectionService
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

  ipcMain.handle(CHANNELS.openLogs, async () => {
    const error = await shell.openPath(deps.logDir)
    if (error) {
      deps.logger.warn('ui.open-logs.failed', { error })
      return { ok: false, error }
    }
    return { ok: true }
  })
}
