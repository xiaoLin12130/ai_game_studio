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
import type { AdvisorService } from './requirements/advisor'
import type { AttachmentService } from './requirements/attachments'
import type { BaselineService, BaselineContent } from './requirements/baseline'
import type { ResearchService } from './requirements/research'
import type { RequirementStore } from './requirements/store'
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
  projectCurrent: 'studio:projects:current',
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

export interface IpcDeps {
  service: DshConnectionService
  tasks: TaskService
  projects: ProjectService
  rules: RulesService
  requirements: RequirementStore
  advisor: AdvisorService
  attachments: AttachmentService
  baselines: BaselineService
  research: ResearchService
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

  // Which project is open is main-process state; the renderer asks rather than assumes.
  ipcMain.handle(CHANNELS.projectCurrent, () => deps.projects.openProject)

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

  // ---- advisor -------------------------------------------------------------------

  ipcMain.handle(CHANNELS.advisorConversations, (_event, projectId: string) => deps.advisor.listConversations(String(projectId)))

  ipcMain.handle(CHANNELS.advisorCreate, (_event, payload: { projectId: string; title: string }) => {
    if (!payload || typeof payload.title !== 'string') throw new Error('a conversation needs a title')
    return deps.advisor.createConversation(String(payload.projectId), payload.title)
  })

  ipcMain.handle(CHANNELS.advisorMessages, (_event, payload: { projectId: string; conversationId: string }) =>
    deps.advisor.listMessages(String(payload.projectId), String(payload.conversationId)),
  )

  ipcMain.handle(CHANNELS.advisorSend, async (_event, payload: { projectId: string; conversationId: string; text: string; attachmentIds?: string[] }) => {
    if (!payload || typeof payload.text !== 'string') throw new Error('a message needs text')
    return deps.advisor.send({
      projectId: String(payload.projectId),
      conversationId: String(payload.conversationId),
      text: payload.text,
      attachmentIds: Array.isArray(payload.attachmentIds) ? payload.attachmentIds.map(String) : [],
    })
  })

  ipcMain.handle(CHANNELS.advisorAttach, (_event, payload: { projectId: string; conversationId?: string | null; filename: string; mime: string; base64: string }) => {
    if (!payload || typeof payload.base64 !== 'string') throw new Error('an attachment needs bytes')
    const buffer = Buffer.from(payload.base64, 'base64')
    return deps.attachments.add({
      projectId: String(payload.projectId),
      conversationId: payload.conversationId ?? null,
      filename: String(payload.filename),
      mime: String(payload.mime),
      buffer,
    })
  })

  ipcMain.handle(CHANNELS.advisorAttachments, (_event, payload: { projectId: string; conversationId?: string | null }) =>
    deps.requirements.listAttachments(String(payload.projectId), payload.conversationId ?? null),
  )

  ipcMain.handle(CHANNELS.advisorRemoveAttachment, (_event, payload: { projectId: string; attachmentId: string }) =>
    deps.attachments.remove(String(payload.projectId), String(payload.attachmentId)),
  )

  // ---- drafts --------------------------------------------------------------------

  ipcMain.handle(CHANNELS.draftsList, (_event, payload: { projectId: string; kind?: string }) =>
    deps.requirements.listDrafts(String(payload.projectId), payload.kind as never),
  )

  ipcMain.handle(CHANNELS.draftCreate, (_event, payload: { projectId: string; kind: string; title: string; content: string }) =>
    deps.requirements.createDraft({
      projectId: String(payload.projectId),
      kind: payload.kind as never,
      title: String(payload.title),
      content: String(payload.content),
    }),
  )

  ipcMain.handle(CHANNELS.draftGet, (_event, payload: { projectId: string; draftId: string }) => {
    const draft = deps.requirements.getDraft(String(payload.projectId), String(payload.draftId))
    if (!draft) return null
    return { draft, versions: deps.requirements.listDraftVersions(draft.id) }
  })

  ipcMain.handle(CHANNELS.draftAddVersion, (_event, payload: { projectId: string; draftId: string; content: string; note?: string }) =>
    deps.requirements.addDraftVersion({
      projectId: String(payload.projectId),
      draftId: String(payload.draftId),
      content: String(payload.content),
      note: payload.note ?? null,
    }),
  )

  ipcMain.handle(CHANNELS.draftSetStatus, (_event, payload: { projectId: string; draftId: string; status: string }) =>
    deps.requirements.setDraftStatus(String(payload.projectId), String(payload.draftId), payload.status as never),
  )

  // ---- research ------------------------------------------------------------------

  ipcMain.handle(CHANNELS.researchList, (_event, projectId: string) => deps.research.listRequests(String(projectId)))
  ipcMain.handle(CHANNELS.researchReports, (_event, projectId: string) => deps.research.listReports(String(projectId)))

  ipcMain.handle(CHANNELS.researchCreate, (_event, payload: { projectId: string; conversationId?: string | null; question: string; scope?: string | null }) =>
    deps.research.createRequest({
      projectId: String(payload.projectId),
      conversationId: payload.conversationId ?? null,
      question: String(payload.question),
      scope: payload.scope ?? null,
    }),
  )

  ipcMain.handle(CHANNELS.researchRun, async (_event, payload: { projectId: string; requestId: string }) =>
    deps.research.run(String(payload.projectId), String(payload.requestId)),
  )

  // ---- baselines -----------------------------------------------------------------

  ipcMain.handle(CHANNELS.baselinePreview, (_event, payload: { projectId: string; content: BaselineContent }) =>
    deps.baselines.preview(String(payload.projectId), payload.content),
  )

  ipcMain.handle(CHANNELS.baselineFreeze, (_event, payload: { projectId: string; content: BaselineContent; confirmedBy: string; sourceDraftId?: string | null }) =>
    deps.baselines.freeze({
      projectId: String(payload.projectId),
      content: payload.content,
      confirmedBy: String(payload.confirmedBy),
      sourceDraftId: payload.sourceDraftId ?? null,
    }),
  )

  ipcMain.handle(CHANNELS.baselineList, (_event, projectId: string) => deps.baselines.list(String(projectId)))
  ipcMain.handle(CHANNELS.baselineGet, (_event, payload: { projectId: string; baselineId: string }) =>
    deps.baselines.get(String(payload.projectId), String(payload.baselineId)),
  )
  ipcMain.handle(CHANNELS.baselineCompare, (_event, payload: { projectId: string; leftId: string; rightId: string }) =>
    deps.baselines.compare(String(payload.projectId), String(payload.leftId), String(payload.rightId)),
  )

  // ---- change proposals ----------------------------------------------------------

  ipcMain.handle(CHANNELS.proposalList, (_event, projectId: string) => deps.baselines.listProposals(String(projectId)))

  ipcMain.handle(CHANNELS.proposalCreate, (_event, payload: { projectId: string; baselineId: string; title: string; description: string }) =>
    deps.baselines.proposeChange({
      projectId: String(payload.projectId),
      baselineId: String(payload.baselineId),
      title: String(payload.title),
      description: String(payload.description),
      drafts: deps.requirements.listDrafts(String(payload.projectId)),
    }),
  )

  ipcMain.handle(CHANNELS.proposalDecide, (_event, payload: { projectId: string; proposalId: string; status: string; decidedBy: string; note?: string | null }) =>
    deps.baselines.decide({
      projectId: String(payload.projectId),
      proposalId: String(payload.proposalId),
      status: payload.status as never,
      decidedBy: String(payload.decidedBy),
      note: payload.note ?? null,
    }),
  )

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
