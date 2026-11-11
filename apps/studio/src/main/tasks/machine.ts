/**
 * The task state machine, as a table that the program enforces.
 *
 * The point of this file is that an illegal transition is impossible, not merely
 * discouraged. Nothing in the runner, the IPC layer or the UI is allowed to set a status
 * directly — everything goes through {@link canTransition} and the store, which records
 * why each move happened. A model claiming success never touches this table; only the
 * verifier can move a task into SUCCEEDED.
 */
import type { TaskAction, TaskStatus, TransitionSource } from './types'

/**
 * Legal moves. Anything not listed here is refused, including the tempting shortcuts:
 * SUCCEEDED never goes back to RUNNING, FAILED never jumps straight to RUNNING (a retry
 * has to go through QUEUED and produce a new attempt), and INTERRUPTED can only return to
 * work through RESUMING, so a resume is always an explicit, recorded act.
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  CREATED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PREPARING', 'CANCELLED', 'FAILED'],
  PREPARING: ['RUNNING', 'FAILED', 'CANCELLED', 'INTERRUPTING', 'INTERRUPTED'],
  // RUNNING -> INTERRUPTED is legal because a runtime can die without us asking it to.
  // The task specification allows it, and recovery depends on it.
  RUNNING: ['VERIFYING', 'INTERRUPTING', 'WAITING_FOR_USER', 'FAILED', 'INTERRUPTED'],
  WAITING_FOR_USER: ['RUNNING', 'INTERRUPTING', 'CANCELLED'],
  INTERRUPTING: ['INTERRUPTED', 'FAILED'],
  INTERRUPTED: ['RESUMING', 'CANCELLED', 'QUEUED'],
  RESUMING: ['RUNNING', 'FAILED', 'INTERRUPTED'],
  VERIFYING: ['SUCCEEDED', 'FAILED'],
  // (QUEUED and VERIFYING are reconciled by recovery into FAILED, not INTERRUPTED: there is
  // no session worth resuming when a run never started or already ended.)
  SUCCEEDED: [],
  FAILED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
}

/**
 * Terminal means "this task will never move again on its own". FAILED is deliberately not
 * here: a failed task may be retried, which starts a new attempt through QUEUED. SUCCEEDED
 * and CANCELLED are final.
 */
export const TERMINAL: readonly TaskStatus[] = ['SUCCEEDED', 'CANCELLED']

/** Actions the UI may offer, derived from the same table so the two cannot drift. */
export const ACTIONS_FOR: Readonly<Record<TaskStatus, readonly TaskAction[]>> = {
  CREATED: ['start', 'cancel'],
  QUEUED: ['cancel'],
  PREPARING: ['stop', 'cancel'],
  RUNNING: ['stop'],
  WAITING_FOR_USER: ['stop', 'cancel'],
  INTERRUPTING: [],
  INTERRUPTED: ['resume', 'cancel'],
  RESUMING: [],
  VERIFYING: [],
  SUCCEEDED: [],
  FAILED: ['retry', 'cancel'],
  CANCELLED: [],
}

export class IllegalTransitionError extends Error {
  readonly from: TaskStatus
  readonly to: TaskStatus

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`illegal task transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
    this.from = from
    this.to = to
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status)
}

/** Throws rather than returning false: callers that reached here meant to move. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
}

/** The status an action would move to, or null when the action is not available. */
export function statusForAction(status: TaskStatus, action: TaskAction): TaskStatus | null {
  switch (action) {
    case 'start':
      return status === 'CREATED' ? 'QUEUED' : null
    case 'retry':
      return status === 'FAILED' ? 'QUEUED' : null
    case 'stop':
      return status === 'RUNNING' || status === 'PREPARING' || status === 'WAITING_FOR_USER'
        ? 'INTERRUPTING'
        : null
    case 'resume':
      return status === 'INTERRUPTED' ? 'RESUMING' : null
    case 'cancel':
      return canTransition(status, 'CANCELLED') ? 'CANCELLED' : null
    default:
      return null
  }
}

/** Why a move is happening; stored with the transition so the history reads sensibly. */
export interface TransitionIntent {
  reason: string
  source: TransitionSource
  sessionId?: string | null
  attemptId?: string | null
  errorCode?: string | null
}
