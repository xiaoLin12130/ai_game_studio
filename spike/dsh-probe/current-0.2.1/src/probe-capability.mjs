/**
 * Probe CC-5 — capability matrix for the runtime actually installed (0.2.1-rc.3).
 *
 * PHASE 00 tested 0.1.5 and reported its limits as if they were DSH's limits. The
 * review rejected that framing. This probe asks the installed runtime directly,
 * with real JSON-RPC calls, which optional methods exist:
 *
 *   session/resume, session/wait, session/working-directory/get|set,
 *   session/cancel, session/approve, session/close
 *
 * A method that answers -32603 "unknown ... method" does not exist in this build;
 * that is `NOT_SUPPORTED`, not `UNKNOWN`. No model call is involved, so this probe
 * runs even when the provider is unavailable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { HarnessClient, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import { createEvidence, p, step } from './lib/evidence.mjs'
import { waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { EXIT } from './lib/outcome.mjs'

const PROFILE = process.env.CC_PROFILE ?? 'cc-sdk'
const ev = createEvidence('cc-5-capability')
const summary = { probe: 'CC-5-capability', startedAt: new Date().toISOString(), profile: PROFILE }

const dshHome = p('dsh-home')
const workspace = p('workspace')
fs.mkdirSync(workspace, { recursive: true })
summary.lockRecovery = clearStaleProfileLock(dshHome)

// The provider row is not needed to enumerate methods, but mounting it proves the
// route also composes in this profile. If the credential is absent the row still
// loads; only a model call would fail.
const patchPath = p('tmp', 'cc-capability.cordis.yml')
fs.mkdirSync(path.dirname(patchPath), { recursive: true })
fs.writeFileSync(
  patchPath,
  ['- insert:', '    - id: llm-commandcode', "      name: '@mars-sea/dsh-commandcode-provider'", '      config:', '        apiKeyEnv: COMMANDCODE_API_KEY', ''].join('\n'),
)

const METHODS = [
  'session/resume',
  'session/wait',
  'session/working-directory/get',
  'session/working-directory/set',
  'session/cancel',
  'session/approve',
  'session/close',
]

const client = new HarnessClient({ profile: PROFILE, dshHome, initializeTimeoutMs: 300000, patches: [patchPath] })

try {
  client.start()
  summary.serverInfo = (await client.initialize({ cwd: workspace, provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' })).serverInfo
  ev.append('initialize', { serverInfo: summary.serverInfo })

  summary.methods = {}
  for (const method of METHODS) {
    try {
      await client.request(method, { sessionId: 'capability-probe', path: workspace }, 5000)
      summary.methods[method] = { status: 'SUPPORTED', detail: 'answered without error' }
    } catch (error) {
      const message = String(error?.message ?? error)
      const unknownMethod = error instanceof JsonRpcResponseError && /unknown .* method/i.test(message)
      // Distinguish "this build has no such method" from "the method exists but
      // rejected my probe arguments" — the latter still proves existence.
      const methodExistsButRejected = error instanceof JsonRpcResponseError && !unknownMethod
      summary.methods[method] = {
        status: unknownMethod ? 'NOT_SUPPORTED' : methodExistsButRejected ? 'EXISTS_REJECTED_ARGS' : 'ERROR',
        code: error?.code ?? null,
        message: message.slice(0, 200),
      }
    }
  }
  ev.append('methods', summary.methods)
  step('method scan', Object.fromEntries(Object.entries(summary.methods).map(([k, v]) => [k, v.status])))
} catch (error) {
  summary.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 1200) }
  ev.append('probe.error', summary.error)
  step('ERROR', summary.error.message.slice(0, 300))
} finally {
  try {
    await client.close()
  } catch (error) {
    summary.closeError = String(error?.message ?? error)
  }
  const reaped = await waitForRuntimeGone({ dshHome, boundMs: 25000 })
  summary.reap = { status: reaped.status, waitedMs: reaped.waitedMs }

  // This probe is a factual inventory: it passes when every method produced a
  // definite answer (supported or not-supported) and the process tree is gone.
  const definite = Object.values(summary.methods ?? {}).every((m) => ['SUPPORTED', 'EXISTS_REJECTED_ARGS', 'NOT_SUPPORTED'].includes(m.status))
  summary.verdict = !summary.error && definite && reaped.status === PROC.ABSENT ? 'PASS' : 'FAIL'

  summary.finishedAt = new Date().toISOString()
  ev.writeJson('summary.json', summary)
  step(`CC5_RESULT=${summary.verdict}`, { definite, reap: reaped.status })
  process.exitCode = EXIT[summary.verdict]
}

process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
