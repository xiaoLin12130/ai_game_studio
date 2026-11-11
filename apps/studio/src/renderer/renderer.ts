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

interface StudioApi {
  getState(): Promise<StudioState>
  recheck(): Promise<StudioState>
  openLogs(): Promise<{ ok: boolean; error?: string }>
  getDiagnostics(): Promise<Record<string, unknown>>
  onState(callback: (state: StudioState) => void): () => void
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
}

void main()
