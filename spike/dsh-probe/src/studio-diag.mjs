#!/usr/bin/env node
/**
 * Studio diagnostic shell — the minimal runnable surface PHASE 00 asks for.
 *
 * It is deliberately a CLI, not a window: ADR-0001 has not been approved yet, so
 * committing to a desktop shell now would be deciding the stack by accident. What
 * this shows is the exact state surface any future UI must render:
 *
 *   environment  → node / dsh / SDK versions actually in use
 *   connection   → runtime started, handshake identity
 *   session      → the session id the runtime created
 *   run states   → RUNNING / IDLE transitions as they arrive
 *   completion   → the final assistant text (or the reason there is none)
 *   error        → provider or transport failure, with the raw reason
 *   teardown     → close duration and proof the OS process is gone
 *
 * Usage:  node src/studio-diag.mjs ["optional prompt"]
 */
import fs from 'node:fs'
import path from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { p, probeRoot } from './lib/evidence.mjs'
import { clearStaleProfileLock, listChildProcesses, waitForNoDshChild } from './lib/proc.mjs'
import { detectModelBlocker } from './lib/outcome.mjs'

const PROVIDER = process.env.PROBE_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
const PROMPT = process.argv[2] ?? 'In one short sentence, say what you are.'

const readVersion = (relPath) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(probeRoot, relPath), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

const dshHome = p('tmp', 'dsh-home')
const workspace = p('tmp', 'workspace')
for (const dir of [dshHome, workspace]) fs.mkdirSync(dir, { recursive: true })

const line = (label, value) => process.stdout.write(`${label.padEnd(14)}${value}\n`)

process.stdout.write('\n=== AI Game Studio · DSH 诊断（PHASE 00 最小壳）===\n\n')
line('node', process.version)
line('dsh (bundled)', readVersion('node_modules/@deepseek-ai/dsh/package.json'))
line('sdk-client', readVersion('node_modules/@deepseek-ai/dsh-sdk-client/package.json'))
line('profile', 'sdk')
line('provider', PROVIDER)
line('model', MODEL)
line('DSH_HOME', dshHome)
line('workspace', workspace)

const lock = clearStaleProfileLock(dshHome)
if (lock.checked) line('stale lock', lock.cleared ? `cleared (dead pid ${lock.stalePid})` : 'none')

process.stdout.write('\n--- connect ---\n')
const harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome,
  cwd: workspace,
  provider: PROVIDER,
  model: MODEL,
  maxTokens: 512,
  requestTimeoutMs: 180000,
  initializeTimeoutMs: 180000,
})

let startedAt = Date.now()
let failures = 0
try {
  await harness.start()
  line('runtime', `CONNECTED in ${Date.now() - startedAt} ms`)
  const children = listChildProcesses().filter((c) => /dsh/i.test(String(c.CommandLine ?? '')))
  line('child procs', children.length ? children.map((c) => c.ProcessId).join(', ') : 'none observed')

  process.stdout.write('\n--- session ---\n')
  const session = harness.session()
  line('session id', session.id)

  process.stdout.write('\n--- run ---\n')
  line('prompt', JSON.stringify(PROMPT))
  startedAt = Date.now()
  const result = await session.run(PROMPT, {
    onNotification: (notification) => {
      if (notification.method === 'session.status') {
        const status = String(notification.params?.status ?? '').toUpperCase()
        line('status', `${status}  (+${Date.now() - startedAt} ms)`)
      }
    },
  })

  process.stdout.write('\n--- result ---\n')
  line('duration', `${Date.now() - startedAt} ms`)
  line('events', String(result.events.length))
  line('notifications', String(result.notifications.length))
  const blocker = detectModelBlocker(result.events)
  if (blocker.blocked) {
    line('outcome', `ERROR (${blocker.kind} ${blocker.code}/${blocker.status})`)
    line('reason', blocker.message)
    failures += 1
  } else if (result.finalResponse.trim()) {
    line('outcome', 'COMPLETED')
    process.stdout.write(`\n${result.finalResponse.trim()}\n\n`)
  } else {
    line('outcome', 'COMPLETED WITH EMPTY RESPONSE')
    failures += 1
  }
} catch (error) {
  failures += 1
  process.stdout.write('\n--- error ---\n')
  line('outcome', `FAILED (${error?.constructor?.name ?? 'Error'})`)
  line('message', String(error?.message ?? error).split('\n').slice(0, 6).join('\n              '))
} finally {
  process.stdout.write('\n--- teardown ---\n')
  const t0 = Date.now()
  try {
    await harness.close()
    line('close()', `${Date.now() - t0} ms`)
  } catch (error) {
    failures += 1
    line('close()', `FAILED: ${String(error?.message ?? error)}`)
  }
  const reaped = await waitForNoDshChild(15000)
  line('process gone', reaped.gone ? `yes (${reaped.waitedMs} ms)` : 'NO — runtime still alive')
  if (!reaped.gone) failures += 1
  process.stdout.write(`\n=== ${failures === 0 ? 'OK' : 'ATTENTION'} ===\n`)
}

process.exit(failures === 0 ? 0 : 1)
