/**
 * Reading the exit code of the DSH runtime process the SDK owns.
 *
 * PHASE 00 scope gate 6 says: "Runtime 关闭后进程确实退出，记录退出码。"
 * An earlier round quietly rewrote that gate as "process tree is empty + close duration"
 * because the obvious accessor does not exist. It is true that
 * `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` exposes no structured exit-code field:
 *
 *   - `HarnessClient#exitCode` is a private field, not part of the public type;
 *   - `HarnessClientOptions` has no exit/onExit hook;
 *   - `close()` returns `Promise<void>`.
 *
 * But the package *documents* one channel: `TransportClosedError` —
 * "The message carries the exit code and a stderr tail when available."
 * (lib/types/client.d.ts). `HarnessClient.start()` records the child's exit code from
 * `child.once('exit', (code) => ...)` and fails pending subscriptions with
 * `closedError(...)`, which appends `exit code: <n>`. That code comes from Node's exit
 * event on the exact subprocess the SDK spawned, so it is the managed process's exit
 * code — not a launcher's.
 *
 * This module only parses that documented message. It never reads a private field, and
 * it returns `null` rather than guessing: a message without an exit code is `null`,
 * which is how the probe distinguishes "the SDK reported a code" from "we invented one".
 *
 * Known limitation, recorded in the evidence: the value arrives as human-readable text,
 * so a future SDK release may reword it. `parseExitCode` returning `null` is the
 * fail-closed behaviour for that case.
 */

/** The documented phrase, e.g. `exit code: 0` or `exit code: -2`. */
export const EXIT_CODE_PATTERN = /(?:^|\n)exit code: (-?\d+)(?:\n|$)/

/**
 * Extract the exit code the SDK reported in a `TransportClosedError` message.
 *
 * @param {unknown} message the error message (or any value; non-strings are `null`)
 * @returns {number|null} the exit code, or `null` when the message does not carry one
 */
export function parseExitCode(message) {
  if (typeof message !== 'string' || message.length === 0) return null
  const match = EXIT_CODE_PATTERN.exec(message)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * Which claim about SDK support each channel would justify.
 *
 * Kept as data so the evidence file and the reviewer read the same words as the code.
 */
export const EXIT_CODE_CHANNELS = {
  structuredAccessor: {
    available: false,
    detail: 'HarnessClientOptions has no exit hook; HarnessClient#exitCode is private; close() resolves Promise<void>',
  },
  transportClosedError: {
    available: true,
    detail:
      'TransportClosedError message carries "exit code: <n>" (documented in lib/types/client.d.ts); the value originates from child.once("exit") on the SDK-spawned runtime',
  },
  launchProcessTable: {
    available: true,
    detail: 'PROCESS_ABSENT from the OS process table proves the process is gone, and says nothing about the exit code',
  },
}
