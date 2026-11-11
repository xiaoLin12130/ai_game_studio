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
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, code: null }), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ timedOut: false, code })
    })
  })
  const smokePath = path.join(outDir, 'smoke.json')
  const smoke = fs.existsSync(smokePath) ? JSON.parse(fs.readFileSync(smokePath, 'utf8')) : null
  const logPath = path.join(userData, 'logs', 'studio.log')
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-40) : []
  return { mode, wallMs: Date.now() - started, exitCode: exit.timedOut ? null : exit.code, timedOut: exit.timedOut, smoke, logTail: log }
}

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
  scenarios.A.checks = {
    exitZero: result.exitCode === 0,
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
  scenarios.B.checks = {
    exitZero: result.exitCode === 0,
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
  for (const pid of afterCrash) {
    try { spawnSync('taskkill', ['/F', '/PID', pid], { windowsHide: true, timeout: 15000 }) } catch { /* gone */ }
  }
  const recover = await run('task-recover', userData)
  scenarios.C = { crash, recover, orphanPidsAfterCrash: afterCrash }
  scenarios.C.checks = {
    crashedAsExpected: crash.exitCode === 9,
    crashLeftTaskRunning: crash.smoke?.isRunning === true,
    recoveryProducedSmoke: Boolean(recover.smoke),
    sawInterruptedState: recover.smoke?.before?.status === 'INTERRUPTED',
    resumedToTerminal: ['SUCCEEDED', 'FAILED'].includes(recover.smoke?.finalStatus),
    recordedNewAttempt: (recover.smoke?.task?.attempts ?? 0) >= 2,
    appExited: recover.exitCode === 0,
    noLingeringApp: lingering().length === 0,
  }
}

const allChecks = Object.fromEntries(
  Object.entries(scenarios).flatMap(([name, value]) => Object.entries(value.checks ?? {}).map(([k, v]) => [name + '.' + k, v])),
)
const failed = Object.entries(allChecks).filter(([, ok]) => !ok).map(([name]) => name)
const summary = { generatedAt: new Date().toISOString(), exe, checks: allChecks, failed, ok: failed.length === 0, scenarios }
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ok: summary.ok, failed, checks: allChecks }, null, 2))
process.exit(summary.ok ? 0 : 1)
