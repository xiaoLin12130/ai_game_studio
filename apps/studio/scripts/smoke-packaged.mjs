#!/usr/bin/env node
/**
 * Desktop smoke against a *packaged* build (win-unpacked or an installed copy).
 *
 * The important difference from the dev smoke: the app is started as a GUI process, so
 * the inherited ELECTRON_RUN_AS_NODE must be removed first. DSH exports it, and a packaged
 * Electron app that inherits it runs as Node, exits 0 immediately and writes nothing —
 * which looks exactly like a crash and is a very easy way to "pass" a broken build.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-01-b', 'smoke')

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/smoke-packaged.mjs <path to AI Game Studio.exe or its directory>')
  process.exit(2)
}
const exe = fs.statSync(target).isDirectory() ? path.join(target, 'AI Game Studio.exe') : path.resolve(target)
if (!fs.existsSync(exe)) {
  console.error('executable not found: ' + exe)
  process.exit(2)
}

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.STUDIO_SMOKE
delete cleanEnv.STUDIO_SMOKE_OUT
delete cleanEnv.STUDIO_USER_DATA

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run one scenario and wait for the app to exit on its own. */
async function runScenario(name, expect) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pkg-' + name + '-'))
  const outDir = path.join(runDir, 'out')
  const userData = path.join(runDir, 'userData')
  const started = Date.now()

  const child = spawn(exe, [], {
    env: {
      ...cleanEnv,
      STUDIO_SMOKE: name,
      STUDIO_SMOKE_OUT: outDir,
      STUDIO_SMOKE_EXPECT: expect,
      STUDIO_USER_DATA: userData,
      STUDIO_SMOKE_QUIT_DELAY_MS: '400',
    },
    stdio: 'ignore',
  })

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 240000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut: false })
    })
  })

  const smokeJson = path.join(outDir, 'smoke.json')
  const result = fs.existsSync(smokeJson) ? JSON.parse(fs.readFileSync(smokeJson, 'utf8')) : null
  const logPath = path.join(userData, 'logs', 'studio.log')
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) : []
  const probeEnd = [...log].reverse().find((e) => e.event === 'dsh.probe.end')
  const shutdown = [...log].reverse().find((e) => e.event === 'dsh.shutdown.result')

  const entry = {
    scenario: name,
    exe,
    wallMs: Date.now() - started,
    exitCode: exit.timedOut ? null : exit.code,
    producedSmokeJson: Boolean(result),
    state: result?.state ?? null,
    dom: result?.dom ?? null,
    probe: probeEnd ? { status: probeEnd.status, code: probeEnd.code, entryPath: probeEnd.entryPath, durationMs: probeEnd.durationMs } : null,
    teardown: probeEnd?.teardown ?? null,
    shutdown: shutdown ? { completed: shutdown.completed, confirmedGone: shutdown.confirmedGone } : null,
  }

  // The app must be gone; a leftover GUI process is the same defect as a leftover runtime.
  const leftover = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '" + exe.split("'").join("''") + "' } | Select-Object -ExpandProperty ProcessId",
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const leftoverPids = String(leftover.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  entry.lingeringAppPids = leftoverPids

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(entry, null, 2) + '\n')
  return entry
}

const ready = await runScenario('ready', 'READY')
await sleep(300)
const quitting = await runScenario('quit-during-probe', 'READY')

const checks = {
  readyExitZero: ready.exitCode === 0,
  readyProducedJson: ready.producedSmokeJson,
  readyStatus: ready.state?.status === 'READY',
  readyHandshake: Boolean(ready.probe?.status === 'READY'),
  readyTeardownCompleted: ready.teardown?.completed === true,
  readyProcessAbsent: ready.teardown?.processAbsent === true,
  readyNoLingeringApp: (ready.lingeringAppPids?.length ?? 0) === 0,
  quitExitZero: quitting.exitCode === 0,
  quitProducedJson: quitting.producedSmokeJson,
  quitRuntimeGone: quitting.teardown?.processAbsent === true,
  quitNoLingeringApp: (quitting.lingeringAppPids?.length ?? 0) === 0,
}
const ok = Object.values(checks).every(Boolean)
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), exe, checks, ok, ready, quitting }, null, 2) + '\n')
console.log(JSON.stringify({ ok, checks }, null, 2))
process.exit(ok ? 0 : 1)
