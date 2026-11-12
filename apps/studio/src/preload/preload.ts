/**
 * The bridge between the sandboxed page and the main process.
 *
 * Exactly the four calls the UI needs, each one an allow-listed IPC channel string. No
 * `require`, no `fs`, no `ipcRenderer` handed to the page.
 */
import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = {
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

const api = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  recheck: () => ipcRenderer.invoke(CHANNELS.recheck),
  openLogs: () => ipcRenderer.invoke(CHANNELS.openLogs),
  getDiagnostics: () => ipcRenderer.invoke(CHANNELS.getDiagnostics),
  listTasks: () => ipcRenderer.invoke(CHANNELS.tasksList),
  createTask: (request: { title: string; goal: string; type?: string; isolation?: string; projectId?: string | null }) =>
    ipcRenderer.invoke(CHANNELS.taskCreate, request),
  getTask: (id: string) => ipcRenderer.invoke(CHANNELS.taskGet, id),
  actOnTask: (id: string, action: string) => ipcRenderer.invoke(CHANNELS.taskAct, { id, action }),
  onTasksChanged: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.tasksChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.tasksChanged, listener)
  },
  listProjects: () => ipcRenderer.invoke(CHANNELS.projectsList),
  createProject: (input: { name: string; rootPath: string; engine: string; platform: string }) =>
    ipcRenderer.invoke(CHANNELS.projectCreate, input),
  openProject: (id: string) => ipcRenderer.invoke(CHANNELS.projectOpen, id),
  closeProject: (id: string) => ipcRenderer.invoke(CHANNELS.projectClose, id),
  getProject: (id: string) => ipcRenderer.invoke(CHANNELS.projectGet, id),
  updateProjectConfig: (id: string, settings: Record<string, unknown>) =>
    ipcRenderer.invoke(CHANNELS.projectUpdateConfig, { id, settings }),
  backupProject: (id: string) => ipcRenderer.invoke(CHANNELS.projectBackup, id),
  listProjectBackups: (id: string) => ipcRenderer.invoke(CHANNELS.projectBackups, id),
  restoreProject: (id: string, file: string) => ipcRenderer.invoke(CHANNELS.projectRestore, { id, file }),
  listRules: () => ipcRenderer.invoke(CHANNELS.rulesList),
  readRule: (id: string) => ipcRenderer.invoke(CHANNELS.rulesRead, id),
  getProjectState: () => ipcRenderer.invoke(CHANNELS.rulesState),
  onProjectsChanged: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(CHANNELS.projectsChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.projectsChanged, listener)
  },
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state)
    ipcRenderer.on(CHANNELS.stateChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, listener)
  },
}

contextBridge.exposeInMainWorld('studio', api)
