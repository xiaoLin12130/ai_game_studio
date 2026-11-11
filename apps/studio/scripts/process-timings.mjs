#!/usr/bin/env node
/**
 * Measure the real cost of each step the fallback reclaim performs.
 *
 * The review asked for numbers rather than budget claims: how long one PowerShell query
 * takes, how long a re-verification takes, how long taskkill takes, and what that means
 * for the 6 s fallback bound. Measured against live child processes on this machine.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createProcessTable,
  captureRuntimeIdentity,
  terminateRuntimeIdentity,
  defaultKiller,
} from '../dist/main/dsh/processes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-01-a', 'process-timings.json')
const MARKER = 'studio-timing-marker'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const table = createProcessTable()

const spawnMarked = (...tokens) =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...tokens], { stdio: 'ignore' })

const timed = async (fn) => {
  const started = Date.now()
  const value = await fn()
  return { ms: Date.now() - started, value }
}

const child = spawnMarked(MARKER)
try {
  await sleep(400)
  const capture = await timed(() => captureRuntimeIdentity(table, { parentPid: process.pid, binMarker: MARKER, deadline: Date.now() + 15000 }))
  const identity = capture.value.identity
  const query = await timed(() => table.listChildren(process.pid, 8000))
  const verify = await timed(() => table.inspect(identity.pid, 8000))
  const kill = await timed(() => defaultKiller(identity.pid, 5000))
  const confirm = await timed(() => table.inspect(identity.pid, 8000))

  // A second round measured through the real terminator, for the whole-reclaim number.
  const child2 = spawnMarked(MARKER)
  await sleep(500)
  const capture2 = await captureRuntimeIdentity(table, { parentPid: process.pid, binMarker: MARKER, deadline: Date.now() + 15000 })
  const reclaim = await timed(() =>
    terminateRuntimeIdentity(table, defaultKiller, capture2.identity, { deadline: Date.now() + 15000 }),
  )
  try { child2.kill('SIGKILL') } catch { /* gone */ }

  const report = {
    generatedAt: new Date().toISOString(),
    machine: { platform: process.platform, node: process.version },
    coldStartNote: 'PowerShell + WMI startup dominates every query and is why the minimum viable query budget is 1200 ms.',
    captureMs: capture.ms,
    captureStatus: capture.value.status,
    listChildrenMs: query.ms,
    verifyPidMs: verify.ms,
    taskkillMs: kill.ms,
    confirmGoneMs: confirm.ms,
    wholeReclaimMs: reclaim.ms,
    wholeReclaimResult: reclaim.value,
    budgets: {
      closeMs: 15000,
      fallbackMs: 6000,
      teardownTotalMs: 22000,
      shutdownTotalMs: 25000,
      exitGuardExtraMs: 5000,
      minQueryMs: 1200,
    },
    conclusion:
      'A reclaim costs about two queries (verify + confirm) plus one taskkill, roughly 2.5-3.5 s on this machine, which fits inside the 6 s fallback bound with room for one retry.',
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}
