#!/usr/bin/env node
/**
 * Prove the MCP chain with *installed* artifacts only.
 *
 * Runs inside the installed app: the runner is executed by the app's own executable in
 * ELECTRON_RUN_AS_NODE mode, imports the SDK client from the installed app.asar, and tells
 * the installed DSH runtime to spawn the installed Studio MCP server. No dev-mode path is
 * used for the runtime, the client or the server.
 *
 * Usage: node scripts/mcp-packaged.mjs "<install dir>" [--prompt]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-01-b', 'mcp')
const installDir = process.argv[2]
const withPrompt = process.argv.includes('--prompt')
if (!installDir) {
  console.error('usage: node scripts/mcp-packaged.mjs "<install dir>" [--prompt]')
  process.exit(2)
}
const exe = path.join(installDir, 'AI Game Studio.exe')
const asar = path.join(installDir, 'resources', 'app.asar')
const serverEntry = path.join(installDir, 'resources', 'app.asar.unpacked', 'mcp', 'studio-mcp-server.mjs')
const serverFallback = path.join(asar, 'mcp', 'studio-mcp-server.mjs')
for (const [label, p] of [['exe', exe], ['app.asar', asar]]) {
  if (!fs.existsSync(p)) {
    console.error('missing ' + label + ': ' + p)
    process.exit(2)
  }
}
const server = fs.existsSync(serverEntry) ? serverEntry : serverFallback

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-pkg-'))
const auditLog = path.join(run, 'mcp-audit.jsonl')
const dshHome = path.join(run, 'dsh-home')
const patch = path.join(run, 'mcp.cordis.yml')
fs.writeFileSync(
  patch,
  [
    '- insert:',
    '    - id: llm-commandcode',
    "      name: '@mars-sea/dsh-commandcode-provider'",
    '      config:',
    '        apiKeyEnv: COMMANDCODE_API_KEY',
    '    - id: studio-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: studio',
    '        transport: stdio',
    '        command: ' + JSON.stringify(exe),
    '        args:',
    '          - ' + JSON.stringify(server),
    '        env:',
    '          ELECTRON_RUN_AS_NODE: "1"',
    '          STUDIO_MCP_AUDIT_LOG: ' + JSON.stringify(auditLog),
    '        failOnStartupError: true',
    '        toolCallTimeoutMs: 60000',
    '',
  ].join('\n'),
)

const runner = path.join(run, 'runner.mjs')
fs.writeFileSync(runner, `
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ASAR = process.env.RUN_ASAR
const PATCH = process.env.RUN_PATCH
const RUN = process.env.RUN_DIR
const WITH_PROMPT = process.env.RUN_PROMPT === '1'
const clientEntry = path.join(ASAR, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')
const { HarnessClient } = await import(pathToFileURL(clientEntry).href)

const key = process.env.COMMANDCODE_API_KEY ?? null
const dshHome = path.join(RUN, 'dsh-home')
const profileDir = path.join(dshHome, 'profiles', 'sdk')
const exe = process.env.RUN_EXE
const dshBin = path.join(ASAR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// The installed runtime needs the third-party provider inside its own profile. Use the
// installed DSH's plugin manager, exactly as a user would.
function ensureProvider() {
  const manifest = path.join(profileDir, 'node_modules', '@mars-sea', 'dsh-commandcode-provider', 'package.json')
  if (fs.existsSync(manifest)) return 'present'
  const bootstrap = new HarnessClient({ dshHome, profile: 'sdk', initializeTimeoutMs: 90000, env: { ...process.env } })
  try {
    bootstrap.start()
  } catch {}
  try { bootstrap.close() } catch {}
  const install = spawnSync(exe, [dshBin, 'plugin', '--profile', 'sdk', 'add', '@mars-sea/dsh-commandcode-provider@0.15.4'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 300000,
  })
  return install.status === 0 ? 'installed' : 'failed:' + String(install.stderr ?? '').slice(-200)
}
const client = new HarnessClient({ dshHome, profile: 'sdk', patches: [PATCH], initializeTimeoutMs: 90000, env: { ...process.env } })
const notes = []
let subError = null
const sub = client.subscribe()
const drain = (async () => { try { for await (const n of sub) notes.push(n) } catch (e) { subError = e } })()

const out = { prompt: WITH_PROMPT, events: [] }
out.provisioning = ensureProvider()
try {
  client.start()
  const init = await client.initialize({ cwd: RUN, provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' })
  out.serverInfo = init?.serverInfo ?? null
  if (WITH_PROMPT) {
    await client.prompt('pkg-' + Date.now(), [{ type: 'text', text: '调用工具 mcp__studio__get_studio_health，然后只输出 TOOL_STATUS=<status>' }])
    const started = Date.now()
    while (Date.now() - started < 240000) {
      if (notes.some((n) => n.method === 'session.status' && n.params?.status === 'idle')) break
      await new Promise((r) => setTimeout(r, 250))
    }
  }
} catch (error) {
  out.error = String(error?.message ?? error).slice(0, 500)
} finally {
  try { await Promise.race([client.close(), new Promise((r) => setTimeout(r, 20000))]) } catch {}
  await Promise.race([drain, new Promise((r) => setTimeout(r, 5000))])
  try { sub.close() } catch {}
}
out.endpoints = { exe: process.env.RUN_EXE, asar: ASAR, patch: PATCH }
console.log('RESULT:' + JSON.stringify(out))
`)

/** Read the user's own commandcode credential; it is passed through env, never logged. */
function readCommandCodeKey() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const match = /COMMANDCODE_API_KEY\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(text)
  return match ? match[1].replace(/\\\r?\n\s*/g, '') : null
}
const credential = readCommandCodeKey()
if (!credential) {
  console.error('no COMMANDCODE_API_KEY in the user credential store; the prompt check needs it')
  process.exit(2)
}

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  COMMANDCODE_API_KEY: credential,
  RUN_ASAR: asar,
  RUN_PATCH: patch,
  RUN_DIR: run,
  RUN_EXE: exe,
}
env.RUN_PROMPT = withPrompt ? '1' : '0'
delete env.STUDIO_SMOKE

const result = spawnSync(exe, [runner], { env, encoding: 'utf8', timeout: 420000 })
const stdout = String(result.stdout ?? '')
const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT:'))
const parsed = line ? JSON.parse(line.slice('RESULT:'.length)) : null
const audit = fs.existsSync(auditLog) ? fs.readFileSync(auditLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) : []

const report = {
  generatedAt: new Date().toISOString(),
  mode: withPrompt ? 'prompt' : 'handshake-only',
  installDir,
  endpoints: { exe, asar, server },
  runnerExit: result.status,
  result: parsed,
  auditKinds: audit.map((a) => a.kind),
  initialized: audit.some((a) => a.kind === 'initialize.completed'),
  toolCalled: audit.some((a) => a.kind === 'tools/call'),
  toolServed: audit.some((a) => a.kind === 'tools/call.served'),
  stderrTail: String(result.stderr ?? '').slice(-800),
}
report.ok = Boolean(parsed?.serverInfo) && report.initialized && (!withPrompt || (report.toolCalled && report.toolServed))

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, withPrompt ? 'packaged-tool-call.json' : 'packaged-handshake.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ok: report.ok, initialized: report.initialized, toolCalled: report.toolCalled, exit: result.status }, null, 2))
process.exit(report.ok ? 0 : 1)
