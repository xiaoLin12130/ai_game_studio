#!/usr/bin/env node
/**
 * Drive the real Electron app through one scenario and prove what happened.
 *
 *   ready              the runtime answers and the UI shows 已就绪
 *   failure            DSH cannot serve the configured profile; the UI must show the
 *                      failure reason instead of a healthy state, and must stay usable
 *   quit-during-probe  ask the app to quit while the handshake is still in flight; the
 *                      runtime must be reaped before the process exits
 *
 * The app writes raw artefacts (absolute paths, Chromium profile) into a throwaway temp
 * directory; only a redacted copy lands in the repository.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const EVIDENCE_ROOT = path.join(REPO, 'evidence', 'phase-01-a', 'smoke')

const scenario = process.argv[2] ?? 'ready'
const EXPECT = {
  ready: 'READY',
  failure: 'UNAVAILABLE',
  'quit-during-probe': null,
}[scenario]
if (EXPECT === undefined) {
  console.error('[smoke] unknown scenario:', scenario)
  process.exit(2)
}

const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-smoke-'))
const USER_DATA = path.join(RAW, 'user-data')
const OUT = path.join(EVIDENCE_ROOT, scenario)
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })

// The failure scenario is a real failure: a profile the runtime cannot load.
if (scenario === 'failure') {
  fs.writeFileSync(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify({ version: 1, dsh: { profile: 'definitely-not-a-profile', probeTimeoutMs: 20000 } }, null, 2) + '\n',
  )
}

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

const env = {
  ...process.env,
  STUDIO_SMOKE: scenario,
  STUDIO_SMOKE_OUT: RAW,
  STUDIO_USER_DATA: USER_DATA,
  STUDIO_SMOKE_QUIT_DELAY_MS: '300',
}
if (EXPECT) env.STUDIO_SMOKE_EXPECT = EXPECT
// DSH itself is an Electron app and exports this; inheriting it turns our app into a Node
// process with no window, which looks exactly like a crash.
delete env.ELECTRON_RUN_AS_NODE

const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const started = Date.now()
const run = spawnSync(electronBin, ['.'], { cwd: ROOT, env, encoding: 'utf8', timeout: 240000 })
const wallMs = Date.now() - started

const smokeFile = path.join(RAW, 'smoke.json')
const smoke = fs.existsSync(smokeFile) ? JSON.parse(fs.readFileSync(smokeFile, 'utf8')) : null

/** Any process still holding this run's isolated DSH home belongs to this app. */
function leftovers() {
  const needle = path.join(USER_DATA, 'dsh-home')
  // The enumerating PowerShell process has the needle in its own command line; without a
  // sentinel the check "finds" itself and reports a phantom leftover.
  const sentinel = 'studio-leftover-check-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  const quote = (value) => "'" + value.split("'").join("''") + "'"
  const script = [
    '$__sentinel = ' + quote(sentinel) + ';',
    '$ErrorActionPreference = "Stop";',
    '$needle = ' + quote(needle) + ';',
    'try {',
    '  $rows = @(Get-CimInstance Win32_Process | Where-Object {',
    '    $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.CommandLine -notlike "*$__sentinel*" -and $_.Name -ne "conhost.exe"',
    '  } | Select-Object ProcessId,Name);',
    '  [pscustomobject]@{ ok = $true; data = $rows } | ConvertTo-Json -Compress -Depth 4',
    '} catch {',
    '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
    '}',
  ].join(' ')
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    const parsed = JSON.parse(raw)
    if (!parsed?.ok) return { error: String(parsed?.error ?? 'process query failed') }
    const rows = Array.isArray(parsed.data) ? parsed.data : parsed.data ? [parsed.data] : []
    return rows.map((row) => ({ pid: Number(row.ProcessId), name: String(row.Name) }))
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/** Read the app log and pull the shutdown record, if the app wrote one. */
function shutdownRecords() {
  const file = path.join(USER_DATA, 'logs', 'studio.log')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .filter((record) => String(record.event ?? '').startsWith('dsh.shutdown'))
}

const after = leftovers()
const shutdown = shutdownRecords()

const checks = {
  exitCodeZero: run.status === 0,
  producedSmokeJson: smoke !== null,
  noLingeringRuntime: Array.isArray(after) && after.length === 0,
}

if (scenario === 'quit-during-probe') {
  const result = shutdown.find((record) => record.event === 'dsh.shutdown.result')
  checks.runtimeWasOwned = result?.teardownAttempted === true
  checks.wasProbingWhenQuit = ['CHECKING', 'READY'].includes(String(smoke?.stateAtQuit?.status))
  checks.shutdownLogged = Boolean(result)
  checks.runtimeConfirmedGone = result?.confirmedGone === true
  checks.closeSucceeded = result?.closeSucceeded === true
  checks.processAbsentConfirmed = result?.processAbsent === true
  checks.noFallbackNeeded = result?.forcedTerminationAttempted === false
  checks.exitCodeObserved = Number.isInteger(result?.exitCode)
} else {
  checks.windowVisible = Boolean(smoke?.window?.visible)
  checks.singleWindow = smoke?.window?.count === 1
  checks.rendererLoaded = typeof smoke?.window?.url === 'string' && smoke.window.url.includes('index.html')
  checks.screenshotWritten = fs.existsSync(path.join(RAW, 'window.png'))
  checks.expectedStatus = smoke?.state?.status === EXPECT
  checks.domMatchesState = smoke?.dom?.headline === smoke?.state?.detail?.message
  checks.pillRendered = typeof smoke?.dom?.pill === 'string' && smoke.dom.pill.length > 0
  if (scenario === 'ready') checks.handshakeIdentity = Boolean(smoke?.state?.serverInfo?.name)
  if (scenario === 'failure') {
    checks.failureReasonShown = /profile|不可用|DSH/i.test(String(smoke?.dom?.headline ?? ''))
    checks.recheckEnabled = smoke?.dom?.recheckDisabled === false
    checks.recheckRanASecondProbe = smoke?.second?.state?.lastCheckedAt !== smoke?.state?.lastCheckedAt
    checks.recheckStayedInFailure = smoke?.second?.state?.status === EXPECT
    checks.recheckUiConsistent = smoke?.second?.dom?.headline === smoke?.second?.state?.detail?.message
    checks.recheckButtonRestored = smoke?.second?.dom?.recheckDisabled === false
  }
  if (scenario === 'ready') checks.exitCodeObservedInUi = /\d/.test(String(smoke?.dom?.factExit ?? ''))
}

const summary = {
  generatedAt: new Date().toISOString(),
  scenario,
  expected: EXPECT,
  electronVersion: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return null } })(),
  wallClockMs: wallMs,
  exitCode: run.status,
  stdoutTail: scrubString(String(run.stdout ?? '').slice(-1500)),
  stderrTail: scrubString(String(run.stderr ?? '').slice(-1500)),
  smoke: smoke ? redact(smoke) : null,
  shutdown,
  leftoversAfterExit: after,
  checks,
  ok: Object.values(checks).every(Boolean),
}

if (fs.existsSync(path.join(RAW, 'window.png'))) {
  fs.copyFileSync(path.join(RAW, 'window.png'), path.join(OUT, 'window.png'))
}
if (smoke) fs.writeFileSync(path.join(OUT, 'smoke.json'), `${JSON.stringify(redact(smoke), null, 2)}\n`)
fs.writeFileSync(path.join(OUT, 'smoke-run.json'), `${JSON.stringify(summary, null, 2)}\n`)

try {
  fs.rmSync(RAW, { recursive: true, force: true })
} catch {
  /* best effort */
}

console.log(JSON.stringify({ scenario, ok: summary.ok, checks, wallMs, exitCode: run.status }, null, 2))
process.exit(summary.ok ? 0 : 1)
