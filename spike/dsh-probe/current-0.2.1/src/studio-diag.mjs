#!/usr/bin/env node
/**
 * Studio diagnostic shell for the 0.2.1-rc.3 slice — PHASE 00 work item 8,
 * "最小可运行的应用壳/诊断页（仅需展示 DSH 连接、版本、会话和事件）".
 *
 * The 0.1.5 slice had one of these (`spike/dsh-probe/src/studio-diag.mjs`); the
 * 0.2.1 slice shipped without it, which left scope gate 4 ("事件/状态能够记录并在 UI
 * 或 CLI 展示") resting on a JSON file plus a 0.1.5 hand transcript. This is the
 * missing surface, ported to the runtime that is actually the delivery target.
 *
 * Two modes, both reproducible and both offline:
 *
 *   live   (default)  spawn the real runtime, print versions, handshake identity,
 *                     session state and teardown. No prompt is sent, so it spends
 *                     no model quota and can be re-run at will.
 *   replay `--replay <evidence-dir>`  render a recorded run's event/status timeline,
 *                     so the display path can be exercised without a new model call.
 *
 * Usage:
 *   node src/studio-diag.mjs
 *   node src/studio-diag.mjs --replay evidence/cc-1-reply
 *   node src/studio-diag.mjs --both      (what `npm run diag` uses for the evidence)
 */
import fs from 'node:fs'
import path from 'node:path'
import { HarnessClient, TransportClosedError } from '@deepseek-ai/dsh-sdk-client'
import { p, probeRoot, writeJsonFile } from './lib/evidence.mjs'
import { dshHomePath, workspacePath } from './lib/paths.mjs'
import { waitForRuntimeGone, clearStaleProfileLock, PROC } from './lib/proc.mjs'
import { parseExitCode } from './lib/exitcode.mjs'
import { out } from './lib/safe-output.mjs'
import { redactText } from './lib/redact.mjs'

const PROFILE = process.env.CC_PROFILE ?? 'cc-sdk'
const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const args = process.argv.slice(2)
const replayDir = args.includes('--replay') ? args[args.indexOf('--replay') + 1] : null
const both = args.includes('--both')

const lines = []
/** Print and remember, so the transcript on disk is exactly what the CLI showed. */
const say = (text = '') => {
  lines.push(text)
  out(`${text}\n`)
}
const row = (label, value) => {
  const padded = String(label).padEnd(20)
  say(`${padded}${padded.length > String(label).length ? '' : ' '}${value}`)
}

const readVersion = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(probeRoot, rel), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function live() {
  say('=== AI Game Studio · DSH 诊断（0.2.1-rc.3 切片）===')
  say('')
  row('mode', 'live（不发送 prompt，不消耗模型额度）')
  row('node', process.version)
  row('dsh (bundled)', readVersion('node_modules/@deepseek-ai/dsh/package.json'))
  row('sdk-client', readVersion('node_modules/@deepseek-ai/dsh-sdk-client/package.json'))
  row('sdk-protocol', readVersion('node_modules/@deepseek-ai/dsh-sdk-protocol/package.json'))
  row('profile', PROFILE)
  row('provider', PROVIDER)
  row('model', MODEL)
  row('DSH_HOME', dshHomePath())
  row('workspace', workspacePath())

  const lock = clearStaleProfileLock(dshHomePath())
  row('stale lock', lock.checked ? (lock.cleared ? `cleared (dead pid ${lock.stalePid})` : 'present, owner alive') : 'none')

  const patchPath = p('tmp', 'cc-provider.cordis.yml')
  fs.mkdirSync(path.dirname(patchPath), { recursive: true })
  fs.writeFileSync(
    patchPath,
    [
      '# commandcode provider row (credential by env NAME only).',
      '- insert:',
      '    - id: llm-commandcode',
      "      name: '@mars-sea/dsh-commandcode-provider'",
      '      config:',
      '        apiKeyEnv: COMMANDCODE_API_KEY',
      '',
    ].join('\n'),
  )

  const client = new HarnessClient({ profile: PROFILE, dshHome: dshHomePath(), patches: [patchPath], initializeTimeoutMs: 300000 })
  const subscription = client.subscribe()
  const statuses = []
  const events = []
  const drain = (async () => {
    try {
      for await (const notification of subscription) {
        if (notification.method === 'session.status') statuses.push(notification.params?.status)
        if (notification.method === 'session.event') events.push(notification.params?.event)
      }
    } catch (error) {
      return error
    }
    return null
  })()

  const started = Date.now()
  client.start()
  const init = await client.initialize({ cwd: workspacePath(), provider: PROVIDER, model: MODEL })
  row('connected', `yes (${Date.now() - started} ms)`)
  row('server', `${init?.serverInfo?.name ?? 'unknown'} ${init?.serverInfo?.version ?? ''}`.trim())
  row('session', '未创建（live 模式不发 prompt，因此没有 session）')
  row('status events', statuses.length === 0 ? 'none observed (no turn was run)' : statuses.join(' → '))
  row('session events', String(events.length))

  await client.close()
  const failure = await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 8000))])
  const raw = failure instanceof TransportClosedError || failure ? String(failure?.message ?? '') : ''
  const exitCode = parseExitCode(raw)
  row('teardown exit code', exitCode === null ? 'not reported by the SDK' : String(exitCode))

  const gone = await waitForRuntimeGone({ dshHome: dshHomePath(), boundMs: 25000 })
  row('process after close', `${gone.status} (${gone.waitedMs} ms)`)

  return {
    mode: 'live',
    node: process.version,
    dsh: readVersion('node_modules/@deepseek-ai/dsh/package.json'),
    sdkClient: readVersion('node_modules/@deepseek-ai/dsh-sdk-client/package.json'),
    serverInfo: init?.serverInfo ?? null,
    connectionMs: Date.now() - started,
    sessionCreated: false,
    statuses,
    eventCount: events.length,
    exitCode,
    exitCodeRawMessage: raw || null,
    processAfterClose: gone.status,
    processAbsent: gone.status === PROC.ABSENT,
  }
}

function replay(dir) {
  const absolute = path.isAbsolute(dir) ? dir : path.join(probeRoot, dir)
  const summary = JSON.parse(fs.readFileSync(path.join(absolute, 'summary.json'), 'utf8'))
  const recordsFile = path.join(absolute, 'records.jsonl')
  const records = fs.existsSync(recordsFile)
    ? fs
        .readFileSync(recordsFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    : []

  say('')
  say(`=== 回放：${path.relative(probeRoot, absolute)} ===`)
  say('')
  row('probe', summary.probe ?? 'unknown')
  row('startedAt', summary.startedAt ?? 'unknown')
  row('finishedAt', summary.finishedAt ?? 'unknown')
  const route = summary.requestRoute ?? summary.turn1Route ?? null
  row('route', route ? `${route.provider ?? '?'} / ${route.model ?? '?'}` : 'not recorded by this probe')
  row('verdict', summary.verdict ?? 'unknown')

  const statusTrail = []
  for (const record of records) {
    if (Array.isArray(record.statuses)) statusTrail.push(...record.statuses)
    say(`  [${record.ts ?? '?'}] ${String(record.type ?? 'record')}${record.status ? ` → ${record.status}` : ''}`)
  }
  say('')
  row('status timeline', statusTrail.length === 0 ? 'none recorded' : statusTrail.join(' → '))
  // Newer probes record `eventCount`; the multi-turn one records per turn. Summing keeps
  // the CLI from printing "0 events" about a run that plainly had eighteen.
  const eventCount =
    summary.eventCount ?? [summary.turn1?.events, summary.turn2?.events].reduce((sum, n) => sum + (Number(n) || 0), 0)
  row('event count', String(eventCount))
  row('notification methods', (summary.notificationMethods ?? []).join(', ') || 'none recorded')
  if (summary.finalResponse) row('final response', JSON.stringify(String(summary.finalResponse).slice(0, 160)))

  return {
    mode: 'replay',
    source: path.relative(probeRoot, absolute),
    probe: summary.probe ?? null,
    statuses: statusTrail,
    eventCount: summary.eventCount ?? 0,
    records: records.length,
  }
}

const report = { generatedAt: new Date().toISOString(), modelCallsMade: 0 }
try {
  if (replayDir) report.replay = replay(replayDir)
  if (!replayDir || both) report.live = await live()
} catch (error) {
  say(`ERROR ${error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 400)}`)
  report.error = { name: error?.constructor?.name, message: String(error?.message ?? error).slice(0, 600) }
}

const evidenceDir = p('evidence', 'cc-7-diag')
fs.mkdirSync(evidenceDir, { recursive: true })
/**
 * The transcript goes through the same redaction as the console: writing the raw lines
 * would publish the absolute DSH home the column above only shows as `<repo>`.
 */
fs.writeFileSync(path.join(evidenceDir, 'cli-output.txt'), `${lines.map((line) => redactText(line)).join('\n')}\n`)
report.transcript = 'cli-output.txt'
report.transcriptLines = lines.length
writeJsonFile(path.join(evidenceDir, 'summary.json'), report)
say('')
say(`[diag] transcript → evidence/cc-7-diag/cli-output.txt`)

const ok = !report.error && (report.live ? report.live.processAbsent : true)
process.exitCode = ok ? 0 : 1
