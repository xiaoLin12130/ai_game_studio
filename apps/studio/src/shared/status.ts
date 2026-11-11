/**
 * The connection status model shared by the main process, the UI and the tests.
 *
 * Pure: no Electron, no Node, no filesystem. Keeping it pure is what makes the status
 * rules testable without launching a window or a runtime.
 */

/** Every state the DSH connection card can be in. */
export type DshStatus =
  | 'UNCHECKED'   // nothing has been probed yet
  | 'CHECKING'    // a probe is running
  | 'READY'       // the probe proved the runtime boots and completes the SDK handshake
  | 'UNAVAILABLE' // DSH is absent or cannot satisfy the minimum runtime condition
  | 'FAILED'      // the probe ran and failed
  | 'TIMEOUT'     // the probe did not finish in time
  | 'UNKNOWN'     // the probe finished but the result cannot be interpreted

/** Why the state is what it is. The UI shows `message`; diagnostics show everything. */
export type DshReasonCode =
  | 'NOT_CHECKED'
  | 'PROBE_RUNNING'
  | 'HANDSHAKE_OK'
  | 'BINARY_MISSING'
  | 'PROFILE_MISSING'
  | 'PROFILE_MANIFEST_INVALID'
  | 'HOME_UNUSABLE'
  | 'ROUTE_UNKNOWN'
  | 'PROFILE_DEGRADED'
  | 'SPAWN_FAILED'
  | 'INIT_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'STOPPED'
  | 'TEARDOWN_UNCONFIRMED'
  | 'INTERNAL_ERROR'

export interface DshStatusDetail {
  code: DshReasonCode
  /** One short sentence a non-technical user can act on. */
  message: string
  /** Raw first line of the underlying error, kept for the diagnostics panel. */
  raw?: string | null
}

export interface DshServerInfo {
  name: string
  version: string
}

export interface DshConnectionState {
  status: DshStatus
  detail: DshStatusDetail
  /** ISO timestamp of the last completed probe, or null when none has run. */
  lastCheckedAt: string | null
  /** Duration of the last probe in milliseconds. */
  lastDurationMs: number | null
  serverInfo: DshServerInfo | null
  /** Version of the bundled dsh package, when it can be read. */
  dshVersion: string | null
  /** How the dsh entry was resolved: bundled with the SDK, or an explicit path from config. */
  entryKind: 'bundled' | 'configured' | 'unknown'
  entryPath: string | null
  /** Exit code the SDK reported for the runtime it spawned, when it reported one. */
  runtimeExitCode: number | null
  /** Set when configuration could not be read and defaults were used. */
  configRecovered: boolean
  configRecoveryNote: string | null
}

export const INITIAL_STATE: DshConnectionState = {
  status: 'UNCHECKED',
  detail: { code: 'NOT_CHECKED', message: '尚未检测 DSH。' },
  lastCheckedAt: null,
  lastDurationMs: null,
  serverInfo: null,
  dshVersion: null,
  entryKind: 'unknown',
  entryPath: null,
  runtimeExitCode: null,
  configRecovered: false,
  configRecoveryNote: null,
}

/** Human labels for the UI. Chinese is the product language; codes stay in English. */
export const STATUS_LABEL: Record<DshStatus, string> = {
  UNCHECKED: '未检测',
  CHECKING: '检测中',
  READY: '已就绪',
  UNAVAILABLE: '不可用',
  FAILED: '连接失败',
  TIMEOUT: '超时',
  UNKNOWN: '未知',
}

/**
 * Turn a raw probe failure into a status plus a user-facing sentence.
 *
 * Kept pure so the classification can be tested with the exact strings the runtime and
 * the SDK produce (both are copied from real failures observed in PHASE 00).
 */
export function classifyProbeError(raw: string | null | undefined): { status: DshStatus; detail: DshStatusDetail } {
  const text = String(raw ?? '')
  const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null

  // Anchors below are copied from failures observed on this machine; the order matters
  // because the SDK wraps the real cause in a generic "JSON-RPC input closed" line.
  if (/Cannot find module/i.test(text)) {
    return {
      status: 'UNAVAILABLE',
      detail: { code: 'BINARY_MISSING', message: 'DSH 启动入口缺失，找不到可执行的运行时模块。', raw: first },
    }
  }
  if (/is not valid JSON|Unexpected token/i.test(text)) {
    return {
      status: 'UNAVAILABLE',
      detail: { code: 'PROFILE_MANIFEST_INVALID', message: 'DSH profile 清单损坏，运行时无法加载配置。', raw: first },
    }
  }
  if (/ENOTDIR|EACCES|EPERM/i.test(text) && /mkdir|open|access/i.test(text)) {
    return {
      status: 'UNAVAILABLE',
      detail: { code: 'HOME_UNUSABLE', message: 'DSH 工作目录不可用（权限或路径冲突）。', raw: first },
    }
  }
  if (/no adapter registered/i.test(text)) {
    return {
      status: 'FAILED',
      detail: { code: 'ROUTE_UNKNOWN', message: 'DSH 没有为当前 provider / model 注册适配器。', raw: first },
    }
  }
  if (/skipping profile bundle/i.test(text)) {
    return {
      status: 'UNAVAILABLE',
      detail: { code: 'PROFILE_DEGRADED', message: 'DSH profile 缺少必需的插件包，运行时降级挂起。', raw: first },
    }
  }
  if (/ENOENT|not found|no such file/i.test(text) && /spawn|dsh|exec/i.test(text)) {
    return {
      status: 'UNAVAILABLE',
      detail: { code: 'BINARY_MISSING', message: '找不到 DSH 程序，无法启动 AI 运行时。', raw: first },
    }
  }
  if (/profile .* does not exist/i.test(text)) {
    return {
      status: 'UNAVAILABLE',
      detail: { code: 'PROFILE_MISSING', message: 'DSH 缺少所需的 profile，运行时无法启动。', raw: first },
    }
  }
  if (/timed out|timeout/i.test(text)) {
    return {
      status: 'TIMEOUT',
      detail: { code: 'TIMEOUT', message: 'DSH 在限定时间内没有响应。', raw: first },
    }
  }
  if (/JSON-RPC input closed|transport closed|exited/i.test(text)) {
    return {
      status: 'FAILED',
      detail: { code: 'INIT_FAILED', message: 'DSH 启动后异常退出，握手未完成。', raw: first },
    }
  }
  if (text.length === 0) {
    return { status: 'UNKNOWN', detail: { code: 'INTERNAL_ERROR', message: '检测未返回结果，无法判断 DSH 状态。', raw: null } }
  }
  return {
    status: 'FAILED',
    detail: { code: 'INIT_FAILED', message: '与 DSH 建立连接失败。', raw: first },
  }
}

/** Does this state mean "the user can use the AI runtime right now"? */
export function isReady(state: DshConnectionState): boolean {
  return state.status === 'READY' && state.serverInfo !== null
}
