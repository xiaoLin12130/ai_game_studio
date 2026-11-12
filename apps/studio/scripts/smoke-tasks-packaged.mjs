#!/usr/bin/env node
/**
 * Task lifecycle scenarios against an installed Windows build.
 *
 * A: create a task, run a real model turn, let Studio verify it, quit, confirm nothing is
 *    left behind.
 * B: start a task, interrupt it, resume it on a fresh runtime, let Studio verify it.
 * C: start a task, kill the app without any shutdown (a crash), relaunch, and check that
 *    the persisted state is recognised and the session can be resumed.
 *
 * Everything runs against the installed executable; no development path is involved.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-01-c', 'packaged')

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/smoke-tasks-packaged.mjs "<install dir or exe>"')
  process.exit(2)
}
const exe = fs.statSync(target).isDirectory() ? path.join(target, 'AI Game Studio.exe') : path.resolve(target)
if (!fs.existsSync(exe)) {
  console.error('executable not found: ' + exe)
  process.exit(2)
}

// DSH exports this; inheriting it turns the packaged GUI into a Node process that exits 0
// in 0.3 s and writes nothing.
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.STUDIO_SMOKE
delete cleanEnv.STUDIO_SMOKE_OUT
delete cleanEnv.STUDIO_USER_DATA

const credential = (() => {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const match = /COMMANDCODE_API_KEY\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(text)
  return match ? match[1].replace(/\\\r?\n\s*/g, '') : null
})()

async function run(mode, userData, timeoutMs = 420000) {
  const outDir = path.join(userData, 'out-' + mode)
  fs.mkdirSync(outDir, { recursive: true })
  // The installed app reads its provider from userData/config.json; a package install has
  // no config yet, and the default route is the one that needs DEEPSEEK_API_KEY.
  const configPath = path.join(userData, 'config.json')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, dsh: { profile: 'sdk', provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', probeTimeoutMs: 60000 }, ui: { autoProbeOnStart: false } }, null, 2) + '\n',
    )
  }
  const started = Date.now()
  const child = spawn(exe, [], {
    env: {
      ...cleanEnv,
      STUDIO_SMOKE: mode,
      STUDIO_SMOKE_OUT: outDir,
      STUDIO_USER_DATA: userData,
      ...(credential ? { COMMANDCODE_API_KEY: credential } : {}),
    },
    stdio: 'ignore',
  })
  const watcher = child.pid ? startIdentityWatcher(child.pid) : null
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, code: null }), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ timedOut: false, code })
    })
  })
  const identities = watcher ? watcher.stop() : []
  const watcherErrors = watcher ? watcher.errors : []
  const smokePath = path.join(outDir, 'smoke.json')
  const smoke = fs.existsSync(smokePath) ? JSON.parse(fs.readFileSync(smokePath, 'utf8')) : null
  const logPath = path.join(userData, 'logs', 'studio.log')
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-40) : []
  return {
    mode,
    wallMs: Date.now() - started,
    exitCode: exit.timedOut ? null : exit.code,
    timedOut: exit.timedOut,
    smoke,
    logTail: log,
    runtimeIdentities: identities,
    runtimeIdentityCount: identities.length,
    identityWatchErrors: watcherErrors,
  }
}

const require = createRequire(import.meta.url)
const { createProcessTable, discoverRuntimeIdentities, verifyRuntimeIdentity } = require(
  path.join(REPO, 'apps', 'studio', 'dist', 'main', 'dsh', 'processes.js'),
)

/**
 * Capture the runtime's OS identity while it is alive.
 *
 * The DSH home is an environment variable, so it is not in the runtime's command line; a
 * home-based matcher reports ABSENT while the process runs. Identity is captured the way
 * PHASE 01-A established: a child of the app process that runs the dsh CLI, pinned with its
 * creation time.
 */
/**
 * Watch the app for the whole run and record every runtime it starts.
 *
 * A task that interrupts and resumes owns two runtimes over its lifetime, so a single
 * capture cannot prove the scenario is clean. This polls while the app lives and keeps each
 * distinct (pid, creationMs) it sees; the caller then verifies every one of them.
 */
function startIdentityWatcher(appPid, intervalMs = 250) {
  const table = createProcessTable()
  const marker = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const seen = new Map()
  const errors = []
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const found = await discoverRuntimeIdentities(table, { parentPid: appPid, binMarker: marker, boundMs: 6000 })
    if (!found.ok) {
      if (found.error) errors.push(found.error)
    } else {
      for (const identity of found.identities) {
        const key = identity.pid + ':' + identity.creationMs
        if (!seen.has(key)) seen.set(key, identity)
      }
    }
    if (!stopped) setTimeout(tick, intervalMs)
  }
  void tick()

  return {
    stop() {
      stopped = true
      return [...seen.values()]
    },
    get identities() {
      return [...seen.values()]
    },
    get errors() {
      return [...errors]
    },
  }
}

/** Verify every captured identity; only all-ABSENT counts as clean. */
async function checkAllIdentities(identities) {
  const checks = []
  for (const identity of identities) {
    checks.push({ identity, verdict: await checkIdentity(identity) })
  }
  return {
    count: identities.length,
    checks,
    allGone: checks.length > 0 && checks.every((entry) => entry.verdict.status === 'ABSENT'),
    statuses: checks.map((entry) => entry.verdict.status),
  }
}

/** Ask the OS whether that identity is still alive. Never turns doubt into ABSENT. */
async function checkIdentity(identity) {
  if (!identity) return { status: 'UNKNOWN', pid: null, creationMs: null, observedCreationMs: null, reason: 'no identity was captured' }
  const table = createProcessTable()
  return verifyRuntimeIdentity(table, identity, 8000)
}

const disposeFailed = (logTail) => (logTail ?? []).some((line) => line.includes('task.service.dispose.failed') || line.includes('runtime.close.failed'))

function lingering() {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*AI Game Studio*' } | Select-Object -ExpandProperty ProcessId"],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  return String(result.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

const scenarios = {}
fs.mkdirSync(OUT, { recursive: true })

// ---- A: create, run, verify --------------------------------------------------------
{
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-A-'))
  const result = await run('task-run', userData)
  scenarios.A = result
  scenarios.A.runtimeIdentitiesCaptured = result.runtimeIdentities
  scenarios.A.runtimeIdentityCount = result.runtimeIdentityCount
  scenarios.A.runtimeChecks = await checkAllIdentities(result.runtimeIdentities)
  scenarios.A.checks = {
    exitZero: result.exitCode === 0,
    disposeHadNoFailure: !disposeFailed(result.logTail),
    runtimeIdentityCaptured: result.runtimeIdentityCount >= 1,
    // A failed or unknown check is never "gone".
    runtimeProcessGone: scenarios.A.runtimeChecks.allGone,
    runtimeCheckStatus: scenarios.A.runtimeChecks.statuses.join(','),
    producedSmoke: Boolean(result.smoke),
    taskSucceeded: result.smoke?.finalStatus === 'SUCCEEDED',
    hadSession: (result.smoke?.task?.sessions ?? 0) >= 1,
    verified: (result.smoke?.task?.verifications ?? []).includes(true),
    transitionsOk: (result.smoke?.task?.transitions ?? []).includes('VERIFYING'),
    noRuntimeLeft: (result.smoke?.runtimes ?? []).length === 0,
    noLingeringApp: lingering().length === 0,
  }
}

// ---- B: interrupt, resume ----------------------------------------------------------
{
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-B-'))
  const result = await run('task-interrupt-resume', userData)
  scenarios.B = result
  scenarios.B.runtimeIdentitiesCaptured = result.runtimeIdentities
  scenarios.B.runtimeIdentityCount = result.runtimeIdentityCount
  scenarios.B.runtimeChecks = await checkAllIdentities(result.runtimeIdentities)
  const distinctB = new Set(result.runtimeIdentities.map((i) => i.pid + ':' + i.creationMs)).size
  scenarios.B.checks = {
    exitZero: result.exitCode === 0,
    disposeHadNoFailure: !disposeFailed(result.logTail),
    // The scenario interrupts one runtime and resumes on a second, so both must be seen.
    runtimeIdentityCount: result.runtimeIdentityCount === 2,
    runtimeIdentitiesDistinct: distinctB === 2,
    allRuntimeProcessesGone: scenarios.B.runtimeChecks.allGone,
    runtimeCheckStatus: scenarios.B.runtimeChecks.statuses.join(','),
    producedSmoke: Boolean(result.smoke),
    wasInterrupted: result.smoke?.atInterrupt?.status === 'INTERRUPTED',
    interruptedIsRecorded: (result.smoke?.atInterrupt?.transitions ?? []).includes('INTERRUPTING'),
    resumedToTerminal: ['SUCCEEDED', 'FAILED'].includes(result.smoke?.finalStatus),
    sessionReused: (result.smoke?.task?.sessions ?? 0) === 1,
    twoAttempts: (result.smoke?.task?.attempts ?? 0) === 2,
    noLingeringApp: lingering().length === 0,
  }
}

// ---- C: crash, relaunch, recover ---------------------------------------------------
{
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-C-'))
  const crash = await run('task-start-and-crash', userData, 300000)
  const afterCrash = lingering()
  // Checked against the identity captured while the runtime was alive, immediately after
  // the crash — before any recovery could clean it up.
  const orphanChecks = await checkAllIdentities(crash.runtimeIdentities)
  for (const pid of afterCrash) {
    try { spawnSync('taskkill', ['/F', '/PID', pid], { windowsHide: true, timeout: 15000 }) } catch { /* gone */ }
  }
  const recover = await run('task-recover', userData)
  const runtimeChecksAfter = await checkAllIdentities(recover.runtimeIdentities)
  scenarios.C = {
    crash,
    recover,
    orphanPidsAfterCrash: afterCrash,
    crashRuntimeIdentities: crash.runtimeIdentities,
    crashRuntimeChecks: orphanChecks,
    recoveryRuntimeIdentities: recover.runtimeIdentities,
    recoveryRuntimeChecks: runtimeChecksAfter,
  }
  scenarios.C.checks = {
    crashedAsExpected: crash.exitCode === 9,
    crashLeftTaskRunning: crash.smoke?.isRunning === true,
    recoveryProducedSmoke: Boolean(recover.smoke),
    sawInterruptedState: recover.smoke?.before?.status === 'INTERRUPTED',
    resumedToTerminal: ['SUCCEEDED', 'FAILED'].includes(recover.smoke?.finalStatus),
    recordedNewAttempt: (recover.smoke?.task?.attempts ?? 0) >= 2,
    appExited: recover.exitCode === 0,
    noLingeringApp: lingering().length === 0,
    disposeHadNoFailure: !disposeFailed(recover.logTail),
    runtimeProcessGone: runtimeChecksAfter.allGone,
    runtimeCheckStatus: runtimeChecksAfter.statuses.join(','),
    crashCapturedIdentity: crash.runtimeIdentityCount >= 1,
    crashOrphanStatus: orphanChecks.statuses.join(','),
    crashLeftNoOrphan: orphanChecks.allGone,
  }
}

const allChecks = Object.fromEntries(
  Object.entries(scenarios).flatMap(([name, value]) => Object.entries(value.checks ?? {}).map(([k, v]) => [name + '.' + k, v])),
)
const failed = Object.entries(allChecks).filter(([, ok]) => !ok).map(([name]) => name)
// Evidence is committed, so absolute paths are written as placeholders: the leak gate
// treats a real drive path in a tracked file as a defect, and reviewer machines differ.
const redact = (value) =>
  typeof value === 'string'
    ? value.replace(/[A-Za-z]:\\[^"']*/g, '<abs-path>').replace(/[A-Za-z]:\/[^"']*/g, '<abs-path>')
    : Array.isArray(value)
      ? value.map(redact)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]))
        : value
const summary = { generatedAt: new Date().toISOString(), exe: '<abs-path>', checks: allChecks, failed, ok: failed.length === 0, scenarios: redact(scenarios) }
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ok: summary.ok, failed, checks: allChecks }, null, 2))
process.exit(summary.ok ? 0 : 1)
