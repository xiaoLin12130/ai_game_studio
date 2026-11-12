/**
 * Renderer: draws the state the main process sends. No Node, no filesystem, no SDK —
 * the page is a view over one serialisable object.
 */
type DshStatus = 'UNCHECKED' | 'CHECKING' | 'READY' | 'UNAVAILABLE' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN'

interface StudioState {
  status: DshStatus
  detail: { code: string; message: string; raw?: string | null }
  lastCheckedAt: string | null
  lastDurationMs: number | null
  serverInfo: { name: string; version: string } | null
  dshVersion: string | null
  entryKind: 'bundled' | 'configured' | 'unknown'
  entryPath: string | null
  runtimeExitCode: number | null
  configRecovered: boolean
  configRecoveryNote: string | null
}

/* --------------------------------------------------------------- task DTOs */

type TaskStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'PREPARING'
  | 'RUNNING'
  | 'WAITING_FOR_USER'
  | 'INTERRUPTING'
  | 'INTERRUPTED'
  | 'RESUMING'
  | 'VERIFYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'

type TaskAction = 'start' | 'stop' | 'resume' | 'retry' | 'cancel'
type TaskIsolation = 'readonly' | 'writable'
type AttemptState = 'RUNNING' | 'ENDED' | 'INTERRUPTED' | 'FAILED'
type SessionState = 'ACTIVE' | 'INTERRUPTED' | 'ENDED' | 'RESUME_FAILED' | 'UNKNOWN'
type TransitionSource = 'user' | 'scheduler' | 'runtime' | 'verifier' | 'recovery' | 'system'

interface TaskSummary {
  id: string
  title: string
  goal: string
  type: string
  isolation: TaskIsolation
  status: TaskStatus
  createdAt: string
  updatedAt: string
  sessionId: string | null
  availableActions: TaskAction[]
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

interface TaskAttempt {
  id: string
  taskId: string
  attemptNo: number
  sessionId: string | null
  runtimeId: string | null
  status: AttemptState
  startedAt: string
  endedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  recordPath: string | null
}

interface TaskSession {
  id: string
  taskId: string
  attemptId: string
  runtimeId: string | null
  state: SessionState
  createdAt: string
  updatedAt: string
  lastError: string | null
}

interface TaskTransition {
  id: number
  taskId: string
  from: TaskStatus
  to: TaskStatus
  reason: string
  source: TransitionSource
  at: string
  sessionId: string | null
  attemptId: string | null
  errorCode: string | null
}

interface TaskVerification {
  id: number
  taskId: string
  attemptId: string
  ok: boolean
  code: string | null
  detail: string | null
  at: string
}

interface RuntimeSnapshot {
  id: string
  isolation: TaskIsolation
  state: string
  pid: number | null
  sessions: number
  leases: number
}

interface TaskDetail extends TaskSummary {
  attempts: TaskAttempt[]
  sessions: TaskSession[]
  transitions: TaskTransition[]
  verifications: TaskVerification[]
}

interface StudioApi {
  getState(): Promise<StudioState>
  recheck(): Promise<StudioState>
  openLogs(): Promise<{ ok: boolean; error?: string }>
  getDiagnostics(): Promise<Record<string, unknown>>
  onState(callback: (state: StudioState) => void): () => void
  listTasks(): Promise<TaskSummary[]>
  createTask(request: {
    title: string
    goal: string
    type?: string
    isolation?: TaskIsolation
  }): Promise<TaskSummary>
  getTask(id: string): Promise<TaskDetail | null>
  actOnTask(id: string, action: TaskAction): Promise<{ task: TaskSummary; runtimes: RuntimeSnapshot[] }>
  onTasksChanged(callback: () => void): () => void
  listProjects(): Promise<ProjectSummary[]>
  createProject(input: { name: string; rootPath: string; engine: string; platform: string }): Promise<ProjectSummary>
  openProject(id: string): Promise<ProjectSummary>
  closeProject(id: string): Promise<{ ok: boolean }>
  getProject(id: string): Promise<ProjectDetail | null>
  updateProjectConfig(id: string, settings: Record<string, unknown>): Promise<ProjectDetail | null>
  listRules(): Promise<{ id: string; scope: string; title: string; description: string }[]>
  readRule(id: string): Promise<Record<string, unknown>>
  getProjectState(): Promise<{ phase: string | null; status: string | null; error: string | null }>
  onProjectsChanged(callback: () => void): () => void
}

/** Merges into the DOM `Window` because this file is a script, not a module. */
interface Window {
  studio: StudioApi
}

const STATUS_LABEL: Record<DshStatus, string> = {
  UNCHECKED: '未检测',
  CHECKING: '检测中',
  READY: '已就绪',
  UNAVAILABLE: '不可用',
  FAILED: '连接失败',
  TIMEOUT: '超时',
  UNKNOWN: '未知',
}

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id)
  if (!element) throw new Error('missing element: ' + id)
  return element
}

const setText = (id: string, text: string): void => {
  byId(id).textContent = text
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function render(state: StudioState): void {
  const pill = byId('status-pill')
  pill.textContent = STATUS_LABEL[state.status] ?? '未知'
  pill.dataset.status = state.status

  const headline = byId('headline')
  headline.textContent = state.detail.message
  headline.dataset.status = state.status

  setText('fact-dsh-version', state.dshVersion ?? '未能读取')
  setText(
    'fact-server',
    state.serverInfo ? state.serverInfo.name + ' ' + state.serverInfo.version : '—',
  )
  setText('fact-checked', formatTime(state.lastCheckedAt))
  setText('fact-duration', state.lastDurationMs === null ? '—' : state.lastDurationMs + ' ms')
  setText('fact-exit', state.runtimeExitCode === null ? 'SDK 未报告' : String(state.runtimeExitCode))
  setText(
    'fact-entry',
    state.entryKind === 'configured'
      ? '自定义路径：' + (state.entryPath ?? '')
      : state.entryKind === 'bundled'
        ? '随官方 SDK 捆绑'
        : '未知',
  )

  const notice = byId('config-notice')
  if (state.configRecovered && state.configRecoveryNote) {
    notice.hidden = false
    notice.textContent = '配置已重置：' + state.configRecoveryNote
  } else {
    notice.hidden = true
    notice.textContent = ''
  }

  const button = byId('recheck') as HTMLButtonElement
  button.disabled = state.status === 'CHECKING'
  button.textContent = state.status === 'CHECKING' ? '检测中…' : '重新检测'
}

async function refreshDiagnostics(): Promise<void> {
  try {
    const info = await window.studio.getDiagnostics()
    setText('diagnostics', JSON.stringify(info, null, 2))
  } catch (error) {
    setText('diagnostics', '诊断信息读取失败：' + String((error as Error)?.message ?? error))
  }
}

/* ---------------------------------------------------------------- task panel */

type Tone =
  | 'neutral'
  | 'queued'
  | 'active'
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'success'
  | 'failed'
  | 'cancelled'

interface StatusMeta {
  label: string
  tone: Tone
  shape: string
}

/**
 * One row per state: a Chinese label plus a colour tone and a shape class. The shape is
 * what makes a status readable without relying on colour (dashed ring = queued, solid dot
 * = running, triangle = waiting, pause bars = interrupted, spinner = moving, check =
 * succeeded, diamond = failed).
 */
const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  CREATED: { label: '已创建', tone: 'neutral', shape: 'ring' },
  QUEUED: { label: '排队中', tone: 'queued', shape: 'dashed' },
  PREPARING: { label: '准备中', tone: 'active', shape: 'spinner' },
  RUNNING: { label: '执行中', tone: 'running', shape: 'dot' },
  WAITING_FOR_USER: { label: '等待用户', tone: 'waiting', shape: 'triangle' },
  INTERRUPTING: { label: '中断中', tone: 'waiting', shape: 'spinner' },
  INTERRUPTED: { label: '已中断', tone: 'interrupted', shape: 'pause' },
  RESUMING: { label: '恢复中', tone: 'interrupted', shape: 'spinner' },
  VERIFYING: { label: '验收中', tone: 'active', shape: 'spinner' },
  SUCCEEDED: { label: '成功', tone: 'success', shape: 'check' },
  FAILED: { label: '失败', tone: 'failed', shape: 'diamond' },
  CANCELLED: { label: '已取消', tone: 'cancelled', shape: 'dash' },
}

const TASK_ACTION_ORDER: TaskAction[] = ['start', 'stop', 'resume', 'retry', 'cancel']

const TASK_ACTION_LABEL: Record<TaskAction, string> = {
  start: '开始',
  stop: '停止',
  resume: '继续',
  retry: '重试',
  cancel: '取消',
}

const TASK_ACTION_BUSY: Record<TaskAction, string> = {
  start: '开始中…',
  stop: '停止中…',
  resume: '恢复中…',
  retry: '重试中…',
  cancel: '取消中…',
}

const ATTEMPT_META: Record<AttemptState, { label: string; tone: Tone }> = {
  RUNNING: { label: '进行中', tone: 'running' },
  ENDED: { label: '已结束', tone: 'neutral' },
  INTERRUPTED: { label: '已中断', tone: 'interrupted' },
  FAILED: { label: '失败', tone: 'failed' },
}

const TRANSITION_SOURCE_LABEL: Record<TransitionSource, string> = {
  user: '用户',
  scheduler: '调度',
  runtime: '运行时',
  verifier: '验收',
  recovery: '恢复',
  system: '系统',
}

/** How many list polls make one detail poll (list: 2s, detail: 6s). */
const TASK_POLL_MS = 2000
const TASK_DETAIL_EVERY_N_POLLS = 3
const MAX_RECENT_EVENTS = 8
const MAX_VISIBLE_ATTEMPTS = 5

interface TaskPanelState {
  tasks: TaskSummary[]
  selectedId: string | null
  detail: TaskDetail | null
  detailError: string | null
  listError: string | null
  actionError: string | null
  busyAction: TaskAction | null
  creating: boolean
  loadedOnce: boolean
  refreshing: boolean
  refreshQueued: boolean
  pollTicks: number
  lastRuntimes: RuntimeSnapshot[]
  techOpen: boolean
  detailFingerprint: string | null
}

const panel: TaskPanelState = {
  tasks: [],
  selectedId: null,
  detail: null,
  detailError: null,
  listError: null,
  actionError: null,
  busyAction: null,
  creating: false,
  loadedOnce: false,
  refreshing: false,
  refreshQueued: false,
  pollTicks: 0,
  lastRuntimes: [],
  techOpen: false,
  detailFingerprint: null,
}

/** Monotonic id so an out-of-order getTask response cannot overwrite a newer one. */
let detailRequest = 0

type DomChild = Node | string | null | undefined | false

function appendAll(parent: HTMLElement, children: DomChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** Build an element with a class and children; text always goes through textContent. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  children: DomChild[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  appendAll(node, children)
  return node
}

function statusMeta(status: TaskStatus | string): StatusMeta {
  const meta = (TASK_STATUS_META as Record<string, StatusMeta | undefined>)[String(status)]
  if (meta) return meta
  return { label: String(status || '未知'), tone: 'neutral', shape: 'ring' }
}

function statusBadge(status: TaskStatus | string, compact = false): HTMLElement {
  const meta = statusMeta(status)
  const badge = el('span', compact ? 'status-badge status-badge-sm' : 'status-badge')
  badge.dataset.tone = meta.tone
  badge.setAttribute('title', String(status))
  badge.append(el('span', 'status-shape shape-' + meta.shape))
  badge.append(el('span', 'status-label', [meta.label]))
  return badge
}

function formatCompact(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  )
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '—'
  const diff = Date.now() - time
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + ' 天前'
  return formatCompact(iso)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '不足 1 秒'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return seconds + ' 秒'
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds > 0 ? minutes + ' 分 ' + restSeconds + ' 秒' : minutes + ' 分'
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? hours + ' 小时 ' + restMinutes + ' 分' : hours + ' 小时'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + '…'
}

function shortSession(id: string | null): string {
  if (!id) return '无会话'
  return id.length <= 18 ? id : id.slice(0, 10) + '…' + id.slice(-4)
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '未知错误')
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : '未知错误'
}

function currentSessionId(detail: TaskDetail): string | null {
  if (detail.sessionId) return detail.sessionId
  const sessions = detail.sessions ?? []
  return sessions.length > 0 ? sessions[sessions.length - 1].id : null
}

function sortTasks(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
}

/* ------------------------------------------------------------- task list */

function renderTaskList(): void {
  const list = byId('task-list')
  const count = byId('tasks-count')
  const alert = byId('tasks-alert')

  count.textContent =
    panel.tasks.length === 0
      ? panel.loadedOnce
        ? '暂无任务'
        : '加载中…'
      : panel.tasks.length + ' 个任务'

  if (panel.listError) {
    alert.hidden = false
    alert.textContent = panel.listError
  } else {
    alert.hidden = true
    alert.textContent = ''
  }

  list.replaceChildren()
  if (panel.tasks.length === 0) {
    const message = panel.loadedOnce ? '还没有任务。在下面新建一个。' : '正在加载任务…'
    list.append(el('li', 'task-list-empty', [message]))
    return
  }
  for (const task of panel.tasks) list.append(renderTaskRow(task))
}

function renderTaskRow(task: TaskSummary): HTMLElement {
  const meta = statusMeta(task.status)
  const row = el('li', 'task-row-wrap')
  const button = el('button', 'task-row')
  button.type = 'button'
  button.dataset.tone = meta.tone
  if (task.id === panel.selectedId) button.dataset.selected = 'true'
  button.setAttribute('aria-pressed', task.id === panel.selectedId ? 'true' : 'false')

  const title = el('span', 'task-row-title', [task.title || '(未命名任务)'])
  title.setAttribute('title', task.title || '(未命名任务)')

  const head = el('span', 'task-row-head')
  head.append(title)
  head.append(statusBadge(task.status))

  const metaRow = el('span', 'task-row-meta')
  metaRow.append(el('span', 'task-type', [task.type || '未分类']))

  const updated = el('span', 'task-time', [formatRelative(task.updatedAt)])
  updated.setAttribute('title', '最近更新：' + formatTime(task.updatedAt))
  metaRow.append(updated)

  const session = el('span', 'task-session', [shortSession(task.sessionId ?? null)])
  session.setAttribute('title', task.sessionId ?? '尚未建立会话')
  metaRow.append(session)

  button.append(head)
  button.append(metaRow)

  if (task.lastErrorMessage) {
    const failure = el('span', 'task-row-error', [truncate(task.lastErrorMessage, 80)])
    failure.setAttribute('title', task.lastErrorMessage)
    button.append(failure)
  }

  button.addEventListener('click', () => {
    selectTask(task.id)
  })
  row.append(button)
  return row
}

/* ----------------------------------------------------------- task detail */

function renderTaskDetail(): void {
  const body = byId('task-detail-body')
  const fingerprint = JSON.stringify([
    panel.selectedId,
    panel.detail,
    panel.detailError,
    panel.actionError,
    panel.busyAction,
    panel.lastRuntimes,
    panel.techOpen,
  ])
  if (fingerprint === panel.detailFingerprint) return
  panel.detailFingerprint = fingerprint

  body.replaceChildren()

  if (!panel.selectedId) {
    body.append(el('p', 'task-detail-placeholder', ['从左侧选择一个任务查看详情。']))
    return
  }

  if (!panel.detail) {
    if (panel.detailError) {
      const alert = el('div', 'tasks-alert', [panel.detailError])
      alert.setAttribute('role', 'alert')
      body.append(alert)
    } else {
      body.append(el('p', 'task-detail-placeholder', ['正在载入任务详情…']))
    }
    return
  }

  const detail = panel.detail
  body.append(renderDetailHeader(detail))
  body.append(renderActionBlock(detail))
  if (panel.detailError) {
    const alert = el('div', 'tasks-alert', [panel.detailError])
    alert.setAttribute('role', 'alert')
    body.append(alert)
  }
  body.append(renderFailureSection(detail))
  body.append(renderAttemptsSection(detail))
  body.append(renderEventsSection(detail))
  body.append(renderVerificationSection(detail))
  body.append(renderTechSection(detail))
}

function metaItem(key: string, value: string, title?: string): HTMLElement {
  const item = el('div', 'meta-item')
  item.append(el('span', 'meta-key', [key]))
  const valueNode = el('span', 'meta-value', [value])
  if (title) valueNode.setAttribute('title', title)
  item.append(valueNode)
  return item
}

function renderDetailHeader(detail: TaskDetail): HTMLElement {
  const header = el('header', 'detail-head')

  const titleRow = el('div', 'detail-title-row')
  titleRow.append(el('h3', 'detail-title', [detail.title || '(未命名任务)']))
  titleRow.append(statusBadge(detail.status))
  header.append(titleRow)

  header.append(el('p', 'detail-goal', [detail.goal || '（没有填写目标）']))

  const meta = el('div', 'detail-meta')
  meta.append(metaItem('类型', detail.type || '未分类'))
  meta.append(metaItem('隔离', detail.isolation === 'readonly' ? '只读' : '写入'))
  meta.append(metaItem('创建', formatCompact(detail.createdAt), formatTime(detail.createdAt)))
  meta.append(metaItem('更新', formatRelative(detail.updatedAt), formatTime(detail.updatedAt)))
  const session = currentSessionId(detail)
  meta.append(metaItem('会话', session ? shortSession(session) : '尚未建立', session ?? '尚未建立会话'))
  header.append(meta)

  return header
}

function renderActionBlock(detail: TaskDetail): HTMLElement {
  const block = el('div', 'detail-action-block')
  const bar = el('div', 'detail-actions')

  const available = TASK_ACTION_ORDER.filter((action) =>
    (detail.availableActions ?? []).includes(action),
  )

  if (available.length === 0) {
    bar.append(el('span', 'detail-actions-empty', ['当前状态没有可执行操作。']))
  }

  for (const action of available) {
    const busy = panel.busyAction === action
    const button = el(
      'button',
      'button action-button' + (action === 'cancel' ? ' button-danger' : ''),
    )
    button.type = 'button'
    button.textContent = busy ? TASK_ACTION_BUSY[action] : TASK_ACTION_LABEL[action]
    button.disabled = panel.busyAction !== null
    if (busy) button.dataset.busy = 'true'
    button.addEventListener('click', () => {
      void runTaskAction(detail.id, action)
    })
    bar.append(button)
  }

  block.append(bar)

  if (panel.actionError) {
    const error = el('div', 'action-error', [panel.actionError])
    error.setAttribute('role', 'alert')
    block.append(error)
  }

  return block
}

function section(title: string, count?: string | null): HTMLElement {
  const node = el('section', 'detail-section')
  const head = el('h4', 'section-title', [title])
  if (count) head.append(el('span', 'section-count', [count]))
  node.append(head)
  return node
}

function renderFailureSection(detail: TaskDetail): HTMLElement {
  const node = section('失败原因')
  if (!detail.lastErrorCode && !detail.lastErrorMessage) {
    node.append(el('p', 'section-empty', ['没有记录到失败原因。']))
    return node
  }
  const box = el('div', 'failure-box')
  if (detail.lastErrorCode) box.append(el('div', 'failure-code', [detail.lastErrorCode]))
  if (detail.lastErrorMessage) box.append(el('p', 'failure-message', [detail.lastErrorMessage]))
  node.append(box)
  return node
}

function attemptTiming(attempt: TaskAttempt): string {
  const started = formatRelative(attempt.startedAt)
  const startMs = Date.parse(attempt.startedAt)
  if (Number.isNaN(startMs)) return started
  const running = attempt.status === 'RUNNING' || !attempt.endedAt
  const endMs = attempt.endedAt ? Date.parse(attempt.endedAt) : Date.now()
  if (Number.isNaN(endMs)) return started
  return started + ' · ' + (running ? '进行 ' : '耗时 ') + formatDuration(Math.max(0, endMs - startMs))
}

function renderAttemptRow(attempt: TaskAttempt): HTMLElement {
  const meta = (ATTEMPT_META as Record<string, { label: string; tone: Tone } | undefined>)[
    String(attempt.status)
  ] ?? { label: String(attempt.status || '未知'), tone: 'neutral' as Tone }

  const row = el('li', 'attempt-row')
  row.dataset.tone = meta.tone
  row.append(el('span', 'attempt-no', ['#' + attempt.attemptNo]))
  row.append(el('span', 'mini-pill', [meta.label]))

  const time = el('span', 'attempt-time', [attemptTiming(attempt)])
  time.setAttribute(
    'title',
    formatCompact(attempt.startedAt) +
      ' → ' +
      (attempt.endedAt ? formatCompact(attempt.endedAt) : '进行中'),
  )
  row.append(time)

  if (attempt.errorCode || attempt.errorMessage) {
    const parts = [attempt.errorCode, attempt.errorMessage].filter(
      (part): part is string => Boolean(part),
    )
    row.append(el('span', 'attempt-error', [parts.join(' · ')]))
  }
  return row
}

function renderAttemptsSection(detail: TaskDetail): HTMLElement {
  const attempts = [...(detail.attempts ?? [])].sort((a, b) => b.attemptNo - a.attemptNo)
  const node = section('执行历史', attempts.length > 0 ? attempts.length + ' 次尝试' : null)

  if (attempts.length === 0) {
    node.append(el('p', 'section-empty', ['尚未开始执行。']))
    return node
  }

  const list = el('ol', 'attempt-list')
  for (const attempt of attempts.slice(0, MAX_VISIBLE_ATTEMPTS)) list.append(renderAttemptRow(attempt))
  node.append(list)

  if (attempts.length > MAX_VISIBLE_ATTEMPTS) {
    node.append(
      el('p', 'section-more', [
        '更早的 ' + (attempts.length - MAX_VISIBLE_ATTEMPTS) + ' 次记录见技术详情。',
      ]),
    )
  }
  return node
}

function renderEventsSection(detail: TaskDetail): HTMLElement {
  const transitions = [...(detail.transitions ?? [])]
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || b.id - a.id)
    .slice(0, MAX_RECENT_EVENTS)

  const node = section('最近事件', transitions.length > 0 ? '最近 ' + transitions.length + ' 条' : null)
  if (transitions.length === 0) {
    node.append(el('p', 'section-empty', ['暂无状态变更记录。']))
    return node
  }

  const list = el('ol', 'event-list')
  for (const transition of transitions) {
    const row = el('li', 'event-row')

    const time = el('span', 'event-time', [formatRelative(transition.at)])
    time.setAttribute('title', formatCompact(transition.at))
    row.append(time)

    const flow = el('span', 'event-flow')
    flow.append(statusBadge(transition.from, true))
    flow.append(el('span', 'event-arrow', ['→']))
    flow.append(statusBadge(transition.to, true))
    row.append(flow)

    row.append(el('span', 'event-reason', [transition.reason || '状态变更']))

    const source =
      (TRANSITION_SOURCE_LABEL as Record<string, string | undefined>)[transition.source] ??
      transition.source
    row.append(el('span', 'event-source', ['来源：' + source]))
    list.append(row)
  }
  node.append(list)
  return node
}

function renderVerificationSection(detail: TaskDetail): HTMLElement {
  const records = [...(detail.verifications ?? [])]
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || b.id - a.id)
    .slice(0, MAX_VISIBLE_ATTEMPTS)

  const node = section('验收结果', records.length > 0 ? records.length + ' 条' : null)
  if (records.length === 0) {
    node.append(el('p', 'section-empty', ['尚未产生验收记录。']))
    return node
  }

  for (const record of records) {
    const row = el('div', 'verify-row')
    row.dataset.ok = record.ok ? 'true' : 'false'
    row.append(el('span', 'verify-mark', [record.ok ? '通过' : '未通过']))
    row.append(el('span', 'verify-code', [record.code || '—']))

    const time = el('span', 'verify-time', [formatRelative(record.at)])
    time.setAttribute('title', formatCompact(record.at))
    row.append(time)

    if (record.detail) row.append(el('p', 'verify-detail', [record.detail]))
    node.append(row)
  }
  return node
}

function techFact(key: string, value: string): HTMLElement {
  const fact = el('div', 'tech-fact')
  fact.append(el('dt', undefined, [key]))
  fact.append(el('dd', undefined, [value]))
  return fact
}

function runtimeIds(detail: TaskDetail): string {
  const ids = new Set<string>()
  for (const session of detail.sessions ?? []) {
    if (session.runtimeId) ids.add(session.runtimeId)
  }
  for (const attempt of detail.attempts ?? []) {
    if (attempt.runtimeId) ids.add(attempt.runtimeId)
  }
  return ids.size > 0 ? Array.from(ids).join(', ') : '—'
}

function renderTechSection(detail: TaskDetail): HTMLElement {
  const details = el('details', 'tech-details')
  details.open = panel.techOpen
  details.append(el('summary', undefined, ['技术详情']))
  details.addEventListener('toggle', () => {
    panel.techOpen = details.open
  })

  const grid = el('dl', 'tech-grid')
  const session = currentSessionId(detail)
  grid.append(techFact('任务 ID', detail.id))
  grid.append(techFact('当前会话 ID', session ?? '尚未建立'))
  grid.append(techFact('运行时', runtimeIds(detail)))
  grid.append(techFact('尝试次数', String((detail.attempts ?? []).length)))
  grid.append(techFact('状态变更', String((detail.transitions ?? []).length)))
  grid.append(techFact('验收记录', String((detail.verifications ?? []).length)))
  details.append(grid)

  const attempts = [...(detail.attempts ?? [])].sort((a, b) => b.attemptNo - a.attemptNo)
  if (attempts.length > 0) {
    details.append(el('h5', 'tech-sub', ['尝试记录']))
    const list = el('ul', 'tech-list')
    for (const attempt of attempts) {
      const parts = [
        '#' + attempt.attemptNo,
        attempt.id,
        attempt.sessionId ? 'session ' + attempt.sessionId : '无 session',
        attempt.runtimeId ? 'runtime ' + attempt.runtimeId : '无 runtime',
        formatCompact(attempt.startedAt) +
          ' → ' +
          (attempt.endedAt ? formatCompact(attempt.endedAt) : '未结束'),
      ]
      if (attempt.recordPath) parts.push('record ' + attempt.recordPath)
      list.append(el('li', undefined, [parts.join(' · ')]))
    }
    details.append(list)
  }

  const sessions = [...(detail.sessions ?? [])]
  if (sessions.length > 0) {
    details.append(el('h5', 'tech-sub', ['会话记录']))
    const list = el('ul', 'tech-list')
    for (const item of sessions) {
      list.append(
        el('li', undefined, [
          item.id +
            ' · ' +
            item.state +
            ' · ' +
            (item.runtimeId ?? '无 runtime') +
            ' · 更新 ' +
            formatCompact(item.updatedAt),
        ]),
      )
    }
    details.append(list)
  }

  details.append(el('h5', 'tech-sub', ['运行时进程']))
  if (panel.lastRuntimes.length === 0) {
    details.append(el('p', 'section-empty', ['尚未获取运行时快照，执行一次任务操作后会刷新。']))
  } else {
    const list = el('ul', 'tech-list')
    for (const runtime of panel.lastRuntimes) {
      list.append(
        el('li', undefined, [
          runtime.id +
            ' · ' +
            (runtime.isolation === 'readonly' ? '只读' : '写入') +
            ' · ' +
            runtime.state +
            ' · pid ' +
            (runtime.pid === null ? '—' : String(runtime.pid)) +
            ' · 会话 ' +
            String(runtime.sessions) +
            ' · 租约 ' +
            String(runtime.leases),
        ]),
      )
    }
    details.append(list)
  }

  return details
}

/* ------------------------------------------------------------- task flow */

async function refreshTaskList(trigger: string): Promise<void> {
  if (panel.refreshing) {
    panel.refreshQueued = true
    return
  }
  panel.refreshing = true

  const showBusy = trigger === 'manual' || trigger === 'init'
  const refreshButton = document.getElementById('tasks-refresh') as HTMLButtonElement | null
  if (showBusy && refreshButton) {
    refreshButton.disabled = true
    refreshButton.textContent = '刷新中…'
  }

  try {
    const tasks = await window.studio.listTasks()
    panel.tasks = sortTasks(Array.isArray(tasks) ? tasks : [])
    panel.listError = null
  } catch (error) {
    panel.listError = '任务列表加载失败：' + describeError(error)
  } finally {
    panel.refreshing = false
    panel.loadedOnce = true
    if (showBusy && refreshButton) {
      refreshButton.disabled = false
      refreshButton.textContent = '刷新'
    }
  }

  renderTaskList()
  syncSelection(trigger)

  if (panel.refreshQueued) {
    panel.refreshQueued = false
    void refreshTaskList('queued')
  }
}

function syncSelection(trigger: string): void {
  if (!panel.selectedId) {
    const first = panel.tasks[0]
    if (first) selectTask(first.id)
    else renderTaskDetail()
    return
  }

  const summary = panel.tasks.find((task) => task.id === panel.selectedId)
  if (!summary) {
    panel.selectedId = null
    panel.detail = null
    panel.detailError = null
    panel.actionError = null
    renderTaskList()
    renderTaskDetail()
    return
  }

  const stale =
    !panel.detail ||
    panel.detail.id !== summary.id ||
    panel.detail.status !== summary.status ||
    panel.detail.updatedAt !== summary.updatedAt
  const periodic = trigger === 'poll' && panel.pollTicks % TASK_DETAIL_EVERY_N_POLLS === 0

  if (stale || periodic) void loadTaskDetail(summary.id)
  else renderTaskDetail()
}

function selectTask(id: string): void {
  if (panel.selectedId === id && panel.detail) return
  panel.selectedId = id
  panel.detail = null
  panel.detailError = null
  panel.actionError = null
  renderTaskList()
  renderTaskDetail()
  void loadTaskDetail(id)
}

async function loadTaskDetail(id: string): Promise<void> {
  const request = ++detailRequest
  try {
    const detail = await window.studio.getTask(id)
    if (request !== detailRequest || panel.selectedId !== id) return
    if (!detail) {
      panel.detail = null
      panel.detailError = '任务不存在或已被删除。'
    } else {
      panel.detail = detail
      panel.detailError = null
    }
  } catch (error) {
    if (request !== detailRequest || panel.selectedId !== id) return
    panel.detailError = '任务详情加载失败：' + describeError(error)
  }
  renderTaskDetail()
}

async function runTaskAction(taskId: string, action: TaskAction): Promise<void> {
  if (panel.busyAction) return
  panel.busyAction = action
  panel.actionError = null
  renderTaskDetail()

  try {
    const result = await window.studio.actOnTask(taskId, action)
    panel.lastRuntimes = Array.isArray(result?.runtimes) ? result.runtimes : []
    if (panel.detail && panel.detail.id === taskId && result?.task) {
      panel.detail = { ...panel.detail, ...result.task }
    }
    await refreshTaskList('action')
    if (panel.selectedId === taskId) await loadTaskDetail(taskId)
  } catch (error) {
    panel.actionError = '操作失败：' + describeError(error)
  } finally {
    panel.busyAction = null
    renderTaskDetail()
  }
}

function setFormError(message: string | null): void {
  const node = byId('task-form-error')
  if (message) {
    node.hidden = false
    node.textContent = message
  } else {
    node.hidden = true
    node.textContent = ''
  }
}

async function submitTaskForm(event: Event): Promise<void> {
  event.preventDefault()
  if (panel.creating) return

  const titleInput = byId('task-title') as HTMLInputElement
  const goalInput = byId('task-goal') as HTMLTextAreaElement
  const title = titleInput.value.trim()
  const goal = goalInput.value.trim()
  const isolationInput = document.querySelector<HTMLInputElement>(
    'input[name="isolation"]:checked',
  )
  const isolation: TaskIsolation = isolationInput?.value === 'readonly' ? 'readonly' : 'writable'

  if (!title) {
    setFormError('请填写标题。')
    titleInput.focus()
    return
  }
  if (!goal) {
    setFormError('请填写目标。')
    goalInput.focus()
    return
  }

  setFormError(null)
  panel.creating = true
  const submit = byId('task-create') as HTMLButtonElement
  submit.disabled = true
  submit.textContent = '创建中…'

  try {
    const created = await window.studio.createTask({ title, goal, isolation })
    titleInput.value = ''
    goalInput.value = ''
    await refreshTaskList('create')
    if (created?.id) selectTask(created.id)
  } catch (error) {
    setFormError('创建失败：' + describeError(error))
  } finally {
    panel.creating = false
    submit.disabled = false
    submit.textContent = '创建任务'
  }
}

async function initTasks(): Promise<void> {
  const api = window.studio

  if (!api || typeof api.listTasks !== 'function') {
    panel.listError = '当前运行时没有提供任务接口，任务面板不可用。'
    renderTaskList()
    renderTaskDetail()
    return
  }

  byId('tasks-refresh').addEventListener('click', () => {
    void refreshTaskList('manual')
  })
  byId('task-form').addEventListener('submit', (event) => {
    void submitTaskForm(event)
  })

  if (typeof api.onTasksChanged === 'function') {
    api.onTasksChanged(() => {
      void refreshTaskList('event')
    })
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshTaskList('visible')
  })

  // The main process advances tasks on its own; the subscription covers fast paths and
  // this timer is the safety net when an event is missed.
  window.setInterval(() => {
    if (document.hidden) return
    panel.pollTicks += 1
    void refreshTaskList('poll')
  }, TASK_POLL_MS)

  await refreshTaskList('init')
}

async function main(): Promise<void> {
  byId('recheck').addEventListener('click', () => {
    void window.studio.recheck()
  })
  byId('open-logs').addEventListener('click', () => {
    void window.studio.openLogs()
  })

  window.studio.onState((state) => {
    render(state)
    void refreshDiagnostics()
  })

  const initial = await window.studio.getState()
  render(initial)
  void refreshDiagnostics()

  try {
    const diagnostics = (await window.studio.getDiagnostics()) as { appVersion?: string }
    if (diagnostics.appVersion) setText('app-version', 'v' + diagnostics.appVersion)
  } catch {
    /* the version chip is cosmetic */
  }

  await initTasks()
  await initProjects()
}


// ---------------------------------------------------------------------------
// Navigation and projects (PHASE 01-D)
// ---------------------------------------------------------------------------

type ProjectSummary = {
  id: string
  name: string
  rootPath: string
  engine: string
  platform: string
  status: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
}

type ProjectDetail = ProjectSummary & {
  config: { settings: Record<string, unknown> } | null
  events: { id: number; kind: string; summary: string | null; at: string }[]
  taskCount: number
}

const ENGINE_LABEL: Record<string, string> = { 'cocos-creator-3.8.6': 'Cocos Creator 3.8.6' }
const PLATFORM_LABEL: Record<string, string> = { 'wechat-minigame': '微信小游戏' }
const EVENT_LABEL: Record<string, string> = {
  'project.created': '创建项目',
  'project.opened': '打开项目',
  'project.closed': '关闭项目',
  'project.config.updated': '更新配置',
  'project.backup.created': '创建备份',
  'project.backup.restored': '恢复备份',
}

let currentProjectId: string | null = null
let selectedProjectId: string | null = null

/** Switch the visible view. Only one is shown at a time. */
function showView(view: string): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'))) {
    button.classList.toggle('is-active', button.dataset.view === view)
  }
  for (const section of Array.from(document.querySelectorAll<HTMLElement>('.view'))) {
    section.hidden = section.dataset.view !== view
  }
}

function projectRow(project: ProjectSummary, onSelect: () => void): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'project-row'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'project-row-button'
  button.addEventListener('click', onSelect)

  const title = document.createElement('span')
  title.className = 'project-row-title'
  title.textContent = project.name
  button.append(title)

  const meta = document.createElement('span')
  meta.className = 'project-row-meta'
  meta.textContent = [ENGINE_LABEL[project.engine] ?? project.engine, PLATFORM_LABEL[project.platform] ?? project.platform].join(' · ')
  button.append(meta)

  const path = document.createElement('span')
  path.className = 'project-row-path'
  path.textContent = project.rootPath
  button.append(path)

  if (currentProjectId === project.id) {
    const badge = document.createElement('span')
    badge.className = 'project-row-badge'
    badge.textContent = '当前项目'
    button.append(badge)
  }
  li.append(button)
  return li
}

async function refreshProjects(): Promise<void> {
  const list = (await window.studio.listProjects()) as ProjectSummary[]
  const workbenchList = byId('workbench-projects')
  const projectsList = byId('projects-list')
  workbenchList.replaceChildren()
  projectsList.replaceChildren()

  const empty = byId('workbench-empty')
  empty.hidden = list.length > 0
  setText('workbench-headline', list.length === 0 ? '还没有项目。' : `共 ${list.length} 个项目。`)

  for (const project of list) {
    workbenchList.append(projectRow(project, () => { void selectProject(project.id) }))
    projectsList.append(projectRow(project, () => { void selectProject(project.id) }))
  }

  const current = byId('workbench-current')
  if (currentProjectId) {
    const project = list.find((entry) => entry.id === currentProjectId)
    current.hidden = false
    current.textContent = project ? `当前项目：${project.name}` : '当前项目已不可用。'
  } else {
    current.hidden = true
  }
}

async function selectProject(id: string): Promise<void> {
  selectedProjectId = id
  const detail = (await window.studio.getProject(id)) as ProjectDetail | null
  const card = byId('project-detail-card')
  if (!detail) {
    card.hidden = true
    return
  }
  card.hidden = false
  setText('project-detail-title', detail.name)

  const facts = byId('project-detail-facts')
  facts.replaceChildren()
  const rows: [string, string][] = [
    ['引擎', ENGINE_LABEL[detail.engine] ?? detail.engine],
    ['目标平台', PLATFORM_LABEL[detail.platform] ?? detail.platform],
    ['项目目录', detail.rootPath],
    ['关联任务', String(detail.taskCount)],
    ['创建时间', formatWhen(detail.createdAt)],
    ['最近打开', detail.lastOpenedAt ? formatWhen(detail.lastOpenedAt) : '从未打开'],
  ]
  for (const [label, value] of rows) {
    const wrap = document.createElement('div')
    wrap.className = 'fact'
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    wrap.append(dt, dd)
    facts.append(wrap)
  }

  const actions = byId('project-detail-actions')
  actions.replaceChildren()
  const openButton = document.createElement('button')
  openButton.type = 'button'
  openButton.className = 'button button-small'
  openButton.textContent = currentProjectId === detail.id ? '已打开' : '打开项目'
  openButton.disabled = currentProjectId === detail.id
  openButton.addEventListener('click', () => { void runProjectAction('open', detail.id) })
  actions.append(openButton)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'button button-ghost button-small'
  closeButton.textContent = '关闭项目'
  closeButton.disabled = currentProjectId !== detail.id
  closeButton.addEventListener('click', () => { void runProjectAction('close', detail.id) })
  actions.append(closeButton)

  const events = byId('project-detail-events')
  events.replaceChildren()
  if (detail.events.length === 0) {
    const li = document.createElement('li')
    li.className = 'event-empty'
    li.textContent = '还没有活动记录。'
    events.append(li)
  }
  for (const event of detail.events) {
    const li = document.createElement('li')
    li.className = 'event-row'
    const label = document.createElement('span')
    label.className = 'event-label'
    label.textContent = EVENT_LABEL[event.kind] ?? event.kind
    const when = document.createElement('span')
    when.className = 'event-when'
    when.textContent = formatWhen(event.at)
    li.append(label, when)
    events.append(li)
  }
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function runProjectAction(action: 'open' | 'close', id: string): Promise<void> {
  const alert = byId('project-detail-alert')
  alert.hidden = true
  try {
    if (action === 'open') {
      await window.studio.openProject(id)
      currentProjectId = id
    } else {
      await window.studio.closeProject(id)
      currentProjectId = null
    }
    await refreshProjects()
    await selectProject(id)
  } catch (error) {
    alert.hidden = false
    alert.textContent = '操作失败：' + describeError(error)
  }
}

async function submitProjectForm(event: Event): Promise<void> {
  event.preventDefault()
  const errorBox = byId('project-form-error')
  errorBox.hidden = true

  const name = (byId('project-name') as HTMLInputElement).value.trim()
  const rootPath = (byId('project-root') as HTMLInputElement).value.trim()
  const engine = (byId('project-engine') as HTMLSelectElement).value
  const platform = (byId('project-platform') as HTMLSelectElement).value

  if (name.length === 0) {
    errorBox.hidden = false
    errorBox.textContent = '请填写项目名称。'
    return
  }
  if (rootPath.length === 0) {
    errorBox.hidden = false
    errorBox.textContent = '请填写项目目录。'
    return
  }

  const button = byId('project-create') as HTMLButtonElement
  button.disabled = true
  button.textContent = '创建中…'
  try {
    const created = (await window.studio.createProject({ name, rootPath, engine, platform })) as ProjectSummary
    ;(byId('project-name') as HTMLInputElement).value = ''
    ;(byId('project-root') as HTMLInputElement).value = ''
    await refreshProjects()
    await selectProject(created.id)
  } catch (error) {
    errorBox.hidden = false
    errorBox.textContent = describeError(error)
  } finally {
    button.disabled = false
    button.textContent = '创建项目'
  }
}

async function initProjects(): Promise<void> {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'))) {
    button.addEventListener('click', () => showView(button.dataset.view ?? 'workbench'))
  }
  byId('project-form').addEventListener('submit', (event) => { void submitProjectForm(event) })
  byId('workbench-refresh').addEventListener('click', () => { void refreshProjects() })
  byId('projects-refresh').addEventListener('click', () => { void refreshProjects() })
  byId('workbench-create').addEventListener('click', () => {
    showView('projects')
    ;(byId('project-name') as HTMLInputElement).focus()
  })
  window.studio.onProjectsChanged(() => { void refreshProjects() })
  await refreshProjects()
}

void main()
