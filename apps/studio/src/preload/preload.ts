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
  advisorConversations: 'studio:advisor:conversations',
  advisorCreate: 'studio:advisor:create',
  advisorMessages: 'studio:advisor:messages',
  advisorSend: 'studio:advisor:send',
  advisorAttach: 'studio:advisor:attach',
  advisorAttachments: 'studio:advisor:attachments',
  advisorRemoveAttachment: 'studio:advisor:attachment-remove',
  draftsList: 'studio:drafts:list',
  draftCreate: 'studio:drafts:create',
  draftGet: 'studio:drafts:get',
  draftAddVersion: 'studio:drafts:version',
  draftSetStatus: 'studio:drafts:status',
  researchList: 'studio:research:list',
  researchCreate: 'studio:research:create',
  researchRun: 'studio:research:run',
  researchReports: 'studio:research:reports',
  baselinePreview: 'studio:baseline:preview',
  baselineFreeze: 'studio:baseline:freeze',
  baselineList: 'studio:baseline:list',
  baselineGet: 'studio:baseline:get',
  baselineCompare: 'studio:baseline:compare',
  proposalList: 'studio:proposals:list',
  proposalCreate: 'studio:proposals:create',
  proposalDecide: 'studio:proposals:decide',
  requirementsChanged: 'studio:requirements:changed',
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
  listConversations: (projectId: string) => ipcRenderer.invoke(CHANNELS.advisorConversations, projectId),
  createConversation: (projectId: string, title: string) => ipcRenderer.invoke(CHANNELS.advisorCreate, { projectId, title }),
  listMessages: (projectId: string, conversationId: string) => ipcRenderer.invoke(CHANNELS.advisorMessages, { projectId, conversationId }),
  sendMessage: (projectId: string, conversationId: string, text: string, attachmentIds?: string[]) =>
    ipcRenderer.invoke(CHANNELS.advisorSend, { projectId, conversationId, text, attachmentIds }),
  attachFile: (projectId: string, conversationId: string | null, filename: string, mime: string, base64: string) =>
    ipcRenderer.invoke(CHANNELS.advisorAttach, { projectId, conversationId, filename, mime, base64 }),
  listAttachments: (projectId: string, conversationId?: string | null) =>
    ipcRenderer.invoke(CHANNELS.advisorAttachments, { projectId, conversationId }),
  removeAttachment: (projectId: string, attachmentId: string) =>
    ipcRenderer.invoke(CHANNELS.advisorRemoveAttachment, { projectId, attachmentId }),
  listDrafts: (projectId: string, kind?: string) => ipcRenderer.invoke(CHANNELS.draftsList, { projectId, kind }),
  createDraft: (projectId: string, kind: string, title: string, content: string) =>
    ipcRenderer.invoke(CHANNELS.draftCreate, { projectId, kind, title, content }),
  getDraft: (projectId: string, draftId: string) => ipcRenderer.invoke(CHANNELS.draftGet, { projectId, draftId }),
  addDraftVersion: (projectId: string, draftId: string, content: string, note?: string) =>
    ipcRenderer.invoke(CHANNELS.draftAddVersion, { projectId, draftId, content, note }),
  setDraftStatus: (projectId: string, draftId: string, status: string) =>
    ipcRenderer.invoke(CHANNELS.draftSetStatus, { projectId, draftId, status }),
  listResearch: (projectId: string) => ipcRenderer.invoke(CHANNELS.researchList, projectId),
  listReports: (projectId: string) => ipcRenderer.invoke(CHANNELS.researchReports, projectId),
  createResearch: (projectId: string, question: string, scope?: string | null) =>
    ipcRenderer.invoke(CHANNELS.researchCreate, { projectId, question, scope }),
  runResearch: (projectId: string, requestId: string) => ipcRenderer.invoke(CHANNELS.researchRun, { projectId, requestId }),
  previewBaseline: (projectId: string, content: unknown) => ipcRenderer.invoke(CHANNELS.baselinePreview, { projectId, content }),
  freezeBaseline: (projectId: string, content: unknown, confirmedBy: string, sourceDraftId?: string | null) =>
    ipcRenderer.invoke(CHANNELS.baselineFreeze, { projectId, content, confirmedBy, sourceDraftId }),
  listBaselines: (projectId: string) => ipcRenderer.invoke(CHANNELS.baselineList, projectId),
  getBaseline: (projectId: string, baselineId: string) => ipcRenderer.invoke(CHANNELS.baselineGet, { projectId, baselineId }),
  compareBaselines: (projectId: string, leftId: string, rightId: string) =>
    ipcRenderer.invoke(CHANNELS.baselineCompare, { projectId, leftId, rightId }),
  listProposals: (projectId: string) => ipcRenderer.invoke(CHANNELS.proposalList, projectId),
  createProposal: (projectId: string, baselineId: string, title: string, description: string) =>
    ipcRenderer.invoke(CHANNELS.proposalCreate, { projectId, baselineId, title, description }),
  decideProposal: (projectId: string, proposalId: string, status: string, decidedBy: string, note?: string | null) =>
    ipcRenderer.invoke(CHANNELS.proposalDecide, { projectId, proposalId, status, decidedBy, note }),
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
