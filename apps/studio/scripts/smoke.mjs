#!/usr/bin/env node
/**
 * Launch the real Electron app on Windows and prove the closed loop.
 *
 * The app writes raw artefacts (including absolute machine paths) into a throwaway temp
 * directory; only a redacted copy lands in the repository. Chromium's own profile data is
 * never published — it contains the user's paths and is not evidence of anything.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const EVIDENCE = path.join(REPO, 'evidence', 'phase-01-a', 'desktop-smoke')
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-smoke-'))
const USER_DATA = path.join(RAW, 'user-data')

fs.mkdirSync(EVIDENCE, { recursive: true })
for (const stale of ['smoke.json', 'smoke-run.json', 'window.png']) {
  fs.rmSync(path.join(EVIDENCE, stale), { force: true })
}

// Everything a reviewer must not see: machine paths and the profile directory.
// Applied to parsed values, not to serialised JSON: escaping backslashes first would make
// the plain-path replacements miss.
const scrubString = (value) =>
  String(value)
    .split(REPO).join('<repo>')
    .split(USER_DATA).join('<user-data>')
    .split(RAW).join('<smoke-tmp>')
    .split(os.homedir()).join('<user-home>')
    .replace(/file:\/\/\/[^"\\s]*/g, 'file://<repo>/apps/studio/dist/renderer/index.html')
    .replace(/[A-Za-z]:\\[^"'\r\n]*/g, '<abs-path>')
    .replace(/[A-Za-z]:\/[^"'\r\n]*/g, '<abs-path>')

const redact = (value) => {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]))
  }
  return value
}

const env = { ...process.env, STUDIO_SMOKE: '1', STUDIO_SMOKE_OUT: RAW, STUDIO_USER_DATA: USER_DATA }
// DSH itself is an Electron app and exports this; inheriting it turns our app into a Node
// process with no window, which looks exactly like a crash.
delete env.ELECTRON_RUN_AS_NODE

const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const started = Date.now()
const run = spawnSync(electronBin, ['.'], { cwd: ROOT, env, encoding: 'utf8', timeout: 240000 })
const wallMs = Date.now() - started

const smokeFile = path.join(RAW, 'smoke.json')
const smoke = fs.existsSync(smokeFile) ? JSON.parse(fs.readFileSync(smokeFile, 'utf8')) : null

/** Any process still holding this run's isolated user-data path belongs to us. */
function leftovers() {
  const needle = USER_DATA.replace(/\\/g, '\\\\')
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object ProcessId,Name);`,
    '$rows | ConvertTo-Json -Compress -Depth 4',
  ].join(' ')
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    const parsed = JSON.parse(raw)
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return rows
      .filter((row) => /node|dsh|electron/i.test(String(row.Name ?? '')))
      .map((row) => ({ pid: Number(row.ProcessId), name: String(row.Name) }))
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const after = leftovers()
const checks = {
  exitCodeZero: run.status === 0,
  producedSmokeJson: smoke !== null,
  windowVisible: Boolean(smoke?.window?.visible),
  singleWindow: smoke?.window?.count === 1,
  rendererLoaded: typeof smoke?.window?.url === 'string' && smoke.window.url.includes('index.html'),
  screenshotWritten: fs.existsSync(path.join(RAW, 'window.png')),
  dshReady: smoke?.state?.status === 'READY',
  handshakeIdentity: Boolean(smoke?.state?.serverInfo?.name),
  runtimeExitCodeObserved: Number.isInteger(smoke?.state?.runtimeExitCode),
  noLingeringRuntime: Array.isArray(after) && after.length === 0,
}

const summary = {
  generatedAt: new Date().toISOString(),
  electronVersion: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return null } })(),
  wallClockMs: wallMs,
  exitCode: run.status,
  stdoutTail: scrubString(String(run.stdout ?? '').slice(-1500)),
  stderrTail: scrubString(String(run.stderr ?? '').slice(-1500)),
  smoke: smoke ? redact(smoke) : null,
  leftoversAfterExit: after,
  checks,
  ok: Object.values(checks).every(Boolean),
}

if (fs.existsSync(path.join(RAW, 'window.png'))) {
  fs.copyFileSync(path.join(RAW, 'window.png'), path.join(EVIDENCE, 'window.png'))
}
fs.writeFileSync(path.join(EVIDENCE, 'smoke.json'), `${JSON.stringify(redact(smoke), null, 2)}\n`)
fs.writeFileSync(path.join(EVIDENCE, 'smoke-run.json'), `${JSON.stringify(summary, null, 2)}\n`)

// The throwaway profile holds Chromium state and absolute paths; it is not evidence.
try {
  fs.rmSync(RAW, { recursive: true, force: true })
} catch {
  /* best effort */
}

console.log(JSON.stringify({ ok: summary.ok, checks, wallMs, exitCode: run.status }, null, 2))
process.exit(summary.ok ? 0 : 1)
