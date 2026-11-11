/**
 * The Studio-side data model for work the user asked for.
 *
 * A Task is the business intent. An Attempt is one execution try. A Session is the DSH
 * conversation identity that carried that try. They are deliberately separate types: a
 * task can be attempted many times, and each attempt can have its own session. A DSH
 * session id is never used as a task id.
 */

export type TaskStatus =
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

export type TransitionSource = 'user' | 'scheduler' | 'runtime' | 'verifier' | 'recovery' | 'system'

/** How much isolation a task needs from other tasks. */
export type TaskIsolation = 'readonly' | 'writable'

export type AttemptStatus = 'RUNNING' | 'ENDED' | 'INTERRUPTED' | 'FAILED'

export type SessionState = 'ACTIVE' | 'INTERRUPTED' | 'ENDED' | 'RESUME_FAILED' | 'UNKNOWN'

export interface TaskRecord {
  id: string
  title: string
  goal: string
  type: string
  isolation: TaskIsolation
  status: TaskStatus
  createdAt: string
  updatedAt: string
  currentAttemptId: string | null
  /** Structured acceptance rules this task must satisfy (JSON). */
  acceptance: AcceptanceSpec
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

export interface AcceptanceSpec {
  /** The run must finish without a transport or protocol error. */
  requireCompletedRun: boolean
  /** The final assistant message must be non-empty. */
  requireResponse: boolean
  /** Tool names that must exist and must not have errored during the run. */
  requiredTools: string[]
}

export const DEFAULT_ACCEPTANCE: AcceptanceSpec = {
  requireCompletedRun: true,
  requireResponse: true,
  requiredTools: [],
}

export interface AttemptRecord {
  id: string
  taskId: string
  attemptNo: number
  sessionId: string | null
  runtimeId: string | null
  status: AttemptStatus
  startedAt: string
  endedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /** Relative path under <userData>/records holding the full event stream. */
  recordPath: string | null
}

export interface SessionRecord {
  id: string
  taskId: string
  attemptId: string
  runtimeId: string | null
  state: SessionState
  createdAt: string
  updatedAt: string
  lastError: string | null
}

export interface TransitionRecord {
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

export interface VerificationRecord {
  id: number
  taskId: string
  attemptId: string
  ok: boolean
  code: string | null
  detail: string | null
  at: string
}

export interface RuntimeRecord {
  id: string
  isolation: TaskIsolation
  pid: number | null
  state: string
  startedAt: string
  endedAt: string | null
  lastError: string | null
}

/** A task the user created, with everything the UI needs in one read. */
export interface TaskView extends TaskRecord {
  attempts: AttemptRecord[]
  sessions: SessionRecord[]
  transitions: TransitionRecord[]
  verifications: VerificationRecord[]
}

export type TaskAction = 'start' | 'stop' | 'resume' | 'retry' | 'cancel'
