/**
 * Probe CC-6 — the exit code of the runtime process the SDK actually manages.
 *
 * PHASE 00 scope gate 6 is: "Runtime 关闭后进程确实退出，记录退出码。"
 * The previous evidence (CC-3) could only show PROCESS_ABSENT, and PHASE_00_R1_EVIDENCE
 * section A7 reworded the gate to "process tree is empty + close duration". Rewording a
 * gate is not satisfying it, so this probe goes back to the original wording and records
 * the real exit code through the one channel the SDK documents (see src/lib/exitcode.mjs).
 *
 * Two scenarios, so the number cannot be a constant:
 *   graceful — normal client.close(): the runtime is asked to shut down and exits 0
 *   forced   — the runtime is killed from outside: the SDK must report the code it saw
 *
 * Neither scenario sends a prompt: initialize + close is enough, so this probe spends no
 * model quota and can be re-run freely. That is deliberate — a gate that costs money to
 * re-check is a gate nobody re-checks.
 *
 * Exit codes: 0 PASS, 3 BLOCKED, 1 FAIL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HarnessClient, TransportClosedError } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { dshHomePath, workspacePath } from './lib/paths.mjs'
import { findRuntimeProcesses, waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { parseExitCode, EXIT_CODE_CHANNELS } from './lib/exitcode.mjs'
import { EXIT } from './lib/outcome.mjs'

const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const PROFILE = process.env.CC_PROFILE ?? 'cc-sdk'

const ev = createEvidence('cc-6-exitcode')
const summary = {
  probe: 'CC-6-runtime-exit-code',
  startedAt: new Date().toISOString(),
  scope_gate: 'Runtime 关闭后进程确实退出，记录退出码。',
  modelCallsMade: 0,
  provider: PROVIDER,
  model: MODEL,
  profile: PROFILE,
  channels: EXIT_CODE_CHANNELS,
}

const dshHome = dshHomePath()
const workspace = workspacePath()
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

/**
 * The provider row the runtime needs before a route can resolve. Written on every run so
 * a stale file from another round cannot silently change what this probe measures.
 */
const patchPath = p('tmp', 'cc-provider.cordis.yml')
fs.mkdirSync(path.dirname(patchPath), { recursive: true })
fs.writeFileSync(
  patchPath,
  [
    '# commandcode provider only — the exit code does not depend on tools or credentials.',
    '- insert:',
    '    - id: llm-commandcode',
    "      name: '@mars-sea/dsh-commandcode-provider'",
    '      config:',
    '        apiKeyEnv: COMMANDCODE_API_KEY',
    '',
  ].join('\n'),
)

const launch = { profile: PROFILE, dshHome, patches: [patchPath], initializeTimeoutMs: 300000 }

/**
 * Collect the exit code the SDK reports for the child it owns.
 *
 * The subscription is opened *before* teardown because the exit handler fails every live
 * subscription with the closed-error, which is the documented place the code appears.
 * If that yields nothing, the after-close re-subscribe route is tried as a second chance;
 * if both return null the caller records "not observed" rather than a number.
 *
 * @param {HarnessClient} client
 * @param {() => Promise<unknown>} teardown what to do to the runtime
 * @returns {Promise<{exitCode: number|null, rawMessage: string|null, errorName: string|null, route: string}>}
 */
async function captureExitCode(client, teardown) {
  const subscription = client.subscribe()
  let failure = null
  const drain = (async () => {
    try {
      for await (const _ of subscription) {
        /* notifications are irrelevant here; only the terminal rejection matters */
      }
    } catch (error) {
      failure = error
    }
  })()

  await teardown()
  await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 8000))])

  let rawMessage = failure ? String(failure?.message ?? failure) : null
  let route = 'exit-handler'
  let exitCode = parseExitCode(rawMessage)

  if (exitCode === null) {
    try {
      const late = client.subscribe()
      await late.next()
    } catch (error) {
      rawMessage = String(error?.message ?? error)
      route = 'post-close-subscribe'
      exitCode = parseExitCode(rawMessage)
    }
  }

  return {
    exitCode,
    rawMessage: rawMessage === null ? null : rawMessage.slice(0, 600),
    errorName: failure ? String(failure?.name ?? (failure instanceof TransportClosedError ? 'TransportClosedError' : 'Error')) : null,
    route,
  }
}

async function scenarioGraceful() {
  const result = { scenario: 'graceful-close' }
  const client = new HarnessClient(launch)
  client.start()
  try {
    const init = await client.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL })
    result.serverInfo = init?.serverInfo ?? null
    const running = findRuntimeProcesses({ dshHome, rootPid: process.pid })
    result.processWhileRunning = { status: running.status, count: running.matches.length }
    result.pids = running.matches.map((m) => m.pid)

    const captured = await captureExitCode(client, () => client.close())
    result.exitCode = captured.exitCode
    result.exitCodeSource = captured.route
    result.exitCodeRawMessage = captured.rawMessage
    result.errorName = captured.errorName

    const gone = await waitForRuntimeGone({ dshHome, boundMs: 25000 })
    result.afterClose = { status: gone.status, waitedMs: gone.waitedMs, remaining: gone.lastMatches?.length ?? 0 }
  } catch (error) {
    result.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 800) }
  }
  return result
}

async function scenarioForced() {
  const result = { scenario: 'forced-kill' }
  const client = new HarnessClient(launch)
  client.start()
  try {
    await client.initialize({ cwd: workspace, provider: PROVIDER, model: MODEL })
    const running = findRuntimeProcesses({ dshHome, rootPid: process.pid })
    result.processWhileRunning = { status: running.status, count: running.matches.length }
    result.pids = running.matches.map((m) => m.pid)
    if (running.status !== PROC.PRESENT || result.pids.length === 0) {
      result.error = { name: 'RuntimeNotFound', message: 'no runtime process matched before the forced kill' }
      return result
    }

    // Kill from outside: the SDK does not initiate this teardown, so the code it reports
    // cannot come from our own close path.
    result.killedBy = 'taskkill /F'
    for (const pid of result.pids) {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true })
      } catch (error) {
        result.killError = String(error?.message ?? error).slice(0, 300)
      }
    }

    const captured = await captureExitCode(client, async () => {
      /* wait for the exit handler to fire; nothing else is requested */
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })
    result.exitCode = captured.exitCode
    result.exitCodeSource = captured.route
    result.exitCodeRawMessage = captured.rawMessage
    result.errorName = captured.errorName

    const gone = await waitForRuntimeGone({ dshHome, boundMs: 25000 })
    result.afterKill = { status: gone.status, waitedMs: gone.waitedMs, remaining: gone.lastMatches?.length ?? 0 }

    try {
      await client.close()
      result.closeAfterKillResolved = true
    } catch (error) {
      result.closeAfterKillResolved = false
      result.closeAfterKillError = String(error?.message ?? error).slice(0, 300)
    }
  } catch (error) {
    result.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 800) }
  }
  return result
}

try {
  const graceful = await scenarioGraceful()
  summary.gracefulClose = graceful
  ev.append('scenario.graceful', {
    exitCode: graceful.exitCode ?? null,
    afterClose: graceful.afterClose ?? null,
    source: graceful.exitCodeSource ?? null,
  })
  step('graceful-close', { exitCode: graceful.exitCode ?? null, process: graceful.afterClose?.status ?? null })

  const forced = await scenarioForced()
  summary.forcedKill = forced
  ev.append('scenario.forced', {
    exitCode: forced.exitCode ?? null,
    afterKill: forced.afterKill ?? null,
    source: forced.exitCodeSource ?? null,
  })
  step('forced-kill', { exitCode: forced.exitCode ?? null, process: forced.afterKill?.status ?? null })

  const observed = Number.isInteger(graceful.exitCode) && Number.isInteger(forced.exitCode)
  summary.assertions = {
    exitCodeObservedOnGracefulClose: Number.isInteger(graceful.exitCode),
    exitCodeZeroOnGracefulClose: graceful.exitCode === 0,
    processAbsentAfterGracefulClose: graceful.afterClose?.status === PROC.ABSENT,
    exitCodeObservedForForcedKill: Number.isInteger(forced.exitCode),
    forcedKillExitCodeDiffersFromGraceful: observed && forced.exitCode !== graceful.exitCode,
    processAbsentAfterForcedKill: forced.afterKill?.status === PROC.ABSENT,
    rawSdkMessageRecorded:
      typeof graceful.exitCodeRawMessage === 'string' && typeof forced.exitCodeRawMessage === 'string',
    noModelCallMade: true,
  }
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 1200) }
  ev.append('probe.error', summary.error)
}

const assertions = summary.assertions ?? {}
const allPass = Object.keys(assertions).length > 0 && Object.values(assertions).every(Boolean)
summary.verdict = summary.error ? 'FAIL' : allPass ? 'PASS' : 'FAIL'
summary.finishedAt = new Date().toISOString()
summary.conclusion = allPass
  ? 'SDK_REPORTS_MANAGED_PROCESS_EXIT_CODE'
  : summary.error
    ? 'PROBE_ERROR'
    : 'EXIT_CODE_NOT_OBSERVED'

ev.append('verdict', { verdict: summary.verdict, conclusion: summary.conclusion, exitCodes: {
  graceful: summary.gracefulClose?.exitCode ?? null,
  forced: summary.forcedKill?.exitCode ?? null,
} })
ev.writeJson('summary.json', summary)
step('CC6_RESULT=' + summary.verdict, { conclusion: summary.conclusion, exitCode: summary.gracefulClose?.exitCode ?? null })
process.exitCode = EXIT[summary.verdict]
process.exit(process.exitCode ?? 0)
