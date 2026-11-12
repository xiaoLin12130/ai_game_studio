#!/usr/bin/env node
/**
 * The advisor against the real DSH runtime.
 *
 * This is the evidence that matters for PHASE 02: a real runtime, the real provider, a real
 * model turn, and the conversation persisted in Studio's own database. A stub runtime proves
 * the plumbing; only this proves the advisor actually talks to a model.
 *
 * Costs a few small turns. Writes JSON; never prints the credential.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-02', 'advisor')
const require = createRequire(import.meta.url)

function readKey() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const m = /COMMANDCODE_API_KEY\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(text)
  return m ? m[1].replace(/\\\r?\n\s*/g, '') : null
}

const key = readKey()
if (key) process.env.COMMANDCODE_API_KEY = key

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-advisor-'))
const dshHome = path.join(run, 'dsh-home')
fs.mkdirSync(dshHome, { recursive: true })

// The isolated home needs the provider installed before a patched run can work: a bare
// profile has no llm adapter, and every prompt then fails with "no adapter registered".
const { spawnSync } = require('node:child_process')
const profileDir = path.join(dshHome, 'profiles', 'sdk')
const providerManifest = path.join(profileDir, 'node_modules', '@mars-sea', 'dsh-commandcode-provider', 'package.json')
if (!fs.existsSync(providerManifest)) {
  const sdk = require('@deepseek-ai/dsh-sdk-client')
  const bootstrap = new sdk.HarnessClient({ dshHome, profile: 'sdk', initializeTimeoutMs: 60000, env: process.env })
  try {
    bootstrap.start()
    await bootstrap.initialize({ cwd: run, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  } catch { /* the profile is materialised even when the handshake fails */ }
  finally { try { await Promise.race([bootstrap.close(), new Promise((r) => setTimeout(r, 15000))]) } catch {} }

  const dshBin = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const install = spawnSync(
    process.execPath,
    [dshBin, 'plugin', '--profile', 'sdk', 'add', '@mars-sea/dsh-commandcode-provider@0.15.4'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: { ...process.env, DSH_HOME: dshHome } },
  )
  if (install.status !== 0) {
    console.error('[advisor-probe] provider install failed:', String(install.stderr ?? '').slice(-400))
  }
}

const { wireServices } = require(path.join(ROOT, 'dist', 'main', 'app-wiring.js'))
const { TaskStore } = require(path.join(ROOT, 'dist', 'main', 'tasks', 'store.js'))

const logger = {
  info: () => {},
  warn: () => {},
  error: (event, fields) => { if (process.env.ADVISOR_DEBUG) console.error('[err]', event, JSON.stringify(fields)) },
}

const app = wireServices({
  logger,
  userDataDir: run,
  dbPath: path.join(run, 'studio.db'),
  dshHome,
  profile: 'sdk',
  provider: 'commandcode',
  model: 'deepseek/deepseek-v4-flash',
  cwd: run,
})

const report = {
  generatedAt: new Date().toISOString(),
  purpose: '真实 DSH 顾问链路：一句话开始讨论、追问、持久化、恢复',
  credentialPresent: Boolean(key),
  steps: [],
  error: null,
}

const projectRoot = fs.mkdtempSync(path.join(run, 'game-'))
const project = app.projects.create({ name: '鸽子幸存者', rootPath: projectRoot, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

try {
  // 1. one sentence starts the conversation
  const conversation = app.advisor.createConversation(project.id, '像素风幸存者')
  report.steps.push({ step: 'create-conversation', ok: true, conversationId: conversation.id })

  const first = await app.advisor.send({
    projectId: project.id,
    conversationId: conversation.id,
    text: '我想做一个像素风格的微信小游戏，玩法类似吸血鬼幸存者，但角色是鸽子。',
  })
  report.steps.push({
    step: 'first-turn',
    ok: first.ok,
    replyLength: first.reply.length,
    replyHead: first.reply.slice(0, 400),
    toolCalls: first.toolCalls.map((t) => t.name),
    error: first.error,
  })

  // 2. the advisor should ask something, not dump a form
  const asked = /[？?]/.test(first.reply)
  report.steps.push({ step: 'asks-a-question', ok: asked, note: asked ? '回复中包含问句' : '回复中没有问句' })

  // 3. the conversation is persisted
  const messages = app.advisor.listMessages(project.id, conversation.id)
  report.steps.push({
    step: 'persisted',
    ok: messages.length >= 2,
    count: messages.length,
    roles: messages.map((m) => m.role),
  })

  // 4. a second turn continues the same conversation
  const second = await app.advisor.send({
    projectId: project.id,
    conversationId: conversation.id,
    text: '核心循环是自动攻击加波次生存，一局 5 分钟。',
  })
  report.steps.push({
    step: 'second-turn',
    ok: second.ok,
    replyLength: second.reply.length,
    replyHead: second.reply.slice(0, 400),
    error: second.error,
  })

  // 5. the context snapshot recorded what went in
  const contexts = app.requirements.listContexts(project.id)
  report.steps.push({
    step: 'context-recorded',
    ok: contexts.length >= 2,
    count: contexts.length,
    kinds: contexts[0]?.sources.map((s) => s.kind) ?? [],
  })

  // 6. project isolation: another project sees nothing
  const otherRoot = fs.mkdtempSync(path.join(run, 'game2-'))
  const other = app.projects.create({ name: '另一个项目', rootPath: otherRoot, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  report.steps.push({
    step: 'project-isolation',
    ok: app.advisor.listConversations(other.id).length === 0 && app.advisor.getConversation(other.id, conversation.id) === null,
  })

  // 7. a draft can be built from the discussion, and a baseline frozen from it
  const draft = app.requirements.createDraft({
    projectId: project.id,
    kind: 'design',
    title: '核心玩法',
    content: '自动攻击 + 波次生存，一局 5 分钟，像素风，微信小游戏。',
  })
  const preview = app.baselines.preview(project.id, {
    name: '需求基线 v1',
    summary: '像素风幸存者小游戏',
    sections: [{ id: draft.id, title: '核心玩法', body: '自动攻击 + 波次生存', confirmed: true }],
    scope: ['核心循环'],
    outOfScope: ['多人联机'],
    openQuestions: [],
    risks: [],
    milestones: [],
    acceptance: [],
    sources: [{ kind: 'draft', label: draft.title, ref: draft.id }],
  })
  report.steps.push({ step: 'baseline-preview', ok: preview.content.length > 0, unconfirmed: preview.unconfirmed })

  const baseline = app.baselines.freeze({
    projectId: project.id,
    content: {
      name: '需求基线 v1',
      summary: '像素风幸存者小游戏',
      sections: [{ id: draft.id, title: '核心玩法', body: '自动攻击 + 波次生存', confirmed: true }],
      scope: ['核心循环'],
      outOfScope: ['多人联机'],
      openQuestions: [],
      risks: [],
      milestones: [],
      acceptance: [],
      sources: [{ kind: 'draft', label: draft.title, ref: draft.id }],
    },
    confirmedBy: 'user',
  })
  report.steps.push({ step: 'baseline-frozen', ok: baseline.status === 'FROZEN', version: baseline.version, hash: baseline.contentHash })

  // 8. the frozen baseline refuses modification
  let refused = false
  try {
    app.store.db.prepare('UPDATE requirement_baselines SET content = ? WHERE id = ?').run('{}', baseline.id)
  } catch {
    refused = true
  }
  report.steps.push({ step: 'frozen-immutable', ok: refused })

  // 9. a change proposal analyses impact without touching the baseline
  const proposal = app.baselines.proposeChange({
    projectId: project.id,
    baselineId: baseline.id,
    title: '加入 Boss 战',
    description: '核心玩法需要加入 Boss 战',
  })
  report.steps.push({
    step: 'change-proposal',
    ok: proposal.status === 'PENDING',
    sections: proposal.impact?.sections ?? [],
    notAnalyzed: proposal.impact?.notAnalyzed.length ?? 0,
  })
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 800)
} finally {
  try { await app.dispose('probe-end') } catch { /* already gone */ }
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'advisor-chain.json'), JSON.stringify(report, null, 2) + '\n')
const failed = report.steps.filter((s) => s.ok === false)
console.log(JSON.stringify({ steps: report.steps.length, failed: failed.length, error: report.error }, null, 2))
process.exit(failed.length === 0 && !report.error ? 0 : 1)
