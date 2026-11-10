/**
 * Probe G — exit codes and the stale-lock defect.
 *
 * The PHASE 00 gate asks for the runtime's exit code on close, not just "the UI
 * closed". The SDK keeps the child's exit code private, so this probe measures the
 * launcher contract directly: `dsh --profile sdk` with stdin already at EOF must
 * quiesce and exit 0.
 *
 * It then reproduces the defect found during this phase: a leftover profile writer
 * lock whose owner pid is dead makes every later boot fail with exit code 1 and a
 * message that never mentions the lock, because the SDK only surfaces
 * "JSON-RPC input closed".
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { EXIT } from './lib/outcome.mjs'

const ev = createEvidence('g-exit-code')
const dshHome = p('tmp', 'dsh-home')
const lockPath = path.join(dshHome, 'profiles', 'node_modules.lock')
const summary = { probe: 'G-exit-code', startedAt: new Date().toISOString(), dshHome }

/** Run the launcher to completion with stdin closed immediately. */
function runLauncherToEof(timeoutMs, home) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('dsh', ['--profile', 'sdk'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'], // stdin immediately at EOF
      shell: true,
      env: { ...process.env, DSH_HOME: home },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal, ms: Date.now() - started, stdout: stdout.slice(0, 1200), stderr: stderr.slice(0, 1600) })
    })
  })
}

try {
  // ---- Case 1: clean boot, stdin EOF triggers the bounded shutdown.
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)
  const clean = await runLauncherToEof(240000, dshHome)
  summary.cleanShutdown = clean
  ev.append('cleanShutdown', clean)
  step('clean EOF shutdown', { exitCode: clean.exitCode, ms: clean.ms })

  // ---- Case 2: a boot that has to heal the profile module fallback while a lock
  // file with a dead owner pid is present.
  //
  // The lock helper (`dsh-atomic-write`) creates the lock with `wx` and, on EEXIST,
  // simply retries until a 2000 ms deadline — it never checks whether the recorded
  // pid is alive. A previous boot that died while holding the lock therefore makes
  // the next boot fail after 2 s, and the SDK above it only reports
  // "JSON-RPC input closed". A fresh home is used so the heal path is actually
  // exercised; on an already-healed home the lock is never touched.
  const lockHome = p('tmp', 'dsh-home-locktest')
  fs.mkdirSync(path.join(lockHome, 'profiles'), { recursive: true })
  const lockHomeLock = path.join(lockHome, 'profiles', 'node_modules.lock')
  const deadPid = 999999
  fs.writeFileSync(lockHomeLock, `${deadPid}\n`)

  const blocked = await runLauncherToEof(90000, lockHome)
  summary.staleLockBoot = { ...blocked, simulatedLockPid: deadPid, home: lockHome }
  ev.append('staleLockBoot', summary.staleLockBoot)
  step('boot with stale lock (fresh home)', { exitCode: blocked.exitCode, ms: blocked.ms })

  if (fs.existsSync(lockHomeLock)) fs.unlinkSync(lockHomeLock)
  summary.lockCleanedUp = !fs.existsSync(lockHomeLock)

  summary.assertions = {
    cleanExitCodeZero: clean.exitCode === 0,
    cleanNoStderr: clean.stderr.trim().length === 0,
    staleLockExitCodeOne: blocked.exitCode === 1,
    staleLockMentionsLock: /writer lock/i.test(blocked.stderr),
  }
  summary.verdict = Object.values(summary.assertions).every(Boolean) ? 'PASS' : 'FAIL'
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message)
  summary.verdict = 'FAIL'
} finally {
  summary.finishedAt = new Date().toISOString()
  ev.append('verdict', { verdict: summary.verdict, assertions: summary.assertions ?? null })
  ev.writeJson('summary.json', summary)
  step(`PROBE_G_RESULT=${summary.verdict}`, summary.assertions ?? null)
  process.exit(EXIT[summary.verdict] ?? 1)
}
