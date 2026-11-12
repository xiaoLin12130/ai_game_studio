/**
 * Context compilation, attachments, baselines and change proposals.
 *
 * These are the business rules that must hold regardless of what the model says: a context
 * that fits its budget, an attachment that cannot escape its project, a baseline that cannot
 * be frozen without confirmation, and a proposal that cannot rewrite one.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { RequirementStore } = require('../dist/main/requirements/store.js')
const { ContextCompiler, DEFAULT_BUDGET } = require('../dist/main/requirements/context.js')
const { AttachmentService, classify, extractText } = require('../dist/main/requirements/attachments.js')
const { BaselineService } = require('../dist/main/requirements/baseline.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-svc2-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const projects = new ProjectStore(store)
  const mk = (id, name) => projects.create({ id, name, rootPath: fs.mkdtempSync(path.join(dir, 'root-' + id + '-')), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  mk('proj-a', 'A')
  mk('proj-b', 'B')
  const req = new RequirementStore(store.db)
  return { dir, store, projects, req }
}

// ------------------------------------------------------------------ context

test('the context includes the user message and the project identity', (t) => {
  const { req } = setup(t)
  const compiler = new ContextCompiler()
  const compiled = compiler.compile({
    project: { id: 'proj-a', name: '鸽子幸存者', engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' },
    userMessage: '我想做一个像素风微信小游戏',
    rules: [], facts: [], openQuestions: [], drafts: [], history: [], attachments: [],
    purpose: 'advisor-turn',
  })
  assert.match(compiled.text, /鸽子幸存者/)
  assert.match(compiled.text, /我想做一个像素风微信小游戏/)
  assert.equal(compiled.truncated, false)
})

test('the context stays inside its budget', (t) => {
  const { req } = setup(t)
  const compiler = new ContextCompiler(2000)
  const history = Array.from({ length: 200 }, (_, i) => ({
    id: 'm' + i, conversationId: 'c', role: i % 2 === 0 ? 'user' : 'assistant', kind: 'text',
    content: '这是一条很长的历史消息，用来把上下文撑爆。'.repeat(5), sessionId: null, seq: i + 1, createdAt: '2026-01-01',
  }))
  const compiled = compiler.compile({
    project: { id: 'proj-a', name: 'P', engine: 'e', platform: 'p' },
    userMessage: '继续',
    rules: [{ title: '规则', content: 'x'.repeat(5000) }],
    facts: ['事实一'], openQuestions: [], drafts: [], history, attachments: [],
    purpose: 'advisor-turn',
  })
  assert.ok(compiled.size <= 2000 + 200, 'context must respect the budget, got ' + compiled.size)
  assert.equal(compiled.truncated, true, 'a trimmed context must say so')
})

test('the context records what it used', (t) => {
  const { req } = setup(t)
  const compiler = new ContextCompiler()
  const compiled = compiler.compile({
    project: { id: 'proj-a', name: 'P', engine: 'e', platform: 'p' },
    userMessage: 'hi',
    rules: [{ title: 'AGENTS', content: 'be careful' }],
    facts: ['平台是微信小游戏'],
    openQuestions: ['美术风格未定'],
    drafts: [], history: [], attachments: [],
    purpose: 'advisor-turn',
  })
  const kinds = compiled.sources.map((s) => s.kind)
  assert.ok(kinds.includes('project'))
  assert.ok(kinds.includes('rule'))
  assert.ok(kinds.includes('fact'))
  assert.ok(kinds.includes('open-question'))
})

test('the newest history survives trimming', (t) => {
  // 50 messages of ~30 characters need ~1500 characters, so this budget forces a trim.
  // The point is which ones survive, not whether anything fits at all.
  const compiler = new ContextCompiler(800)
  const history = Array.from({ length: 50 }, (_, i) => ({
    id: 'm' + i, conversationId: 'c', role: 'user', kind: 'text',
    content: 'OLD-' + i + '-'.repeat(20), sessionId: null, seq: i + 1, createdAt: '2026-01-01',
  }))
  const compiled = compiler.compile({
    project: { id: 'p', name: 'P', engine: 'e', platform: 'p' },
    userMessage: 'now',
    rules: [], facts: [], openQuestions: [], drafts: [], history, attachments: [],
    purpose: 'advisor-turn',
  })
  assert.equal(compiled.truncated, true, 'this budget must force a trim')
  assert.match(compiled.text, /OLD-49/, 'the most recent message must be kept')
  assert.doesNotMatch(compiled.text, /OLD-0-/, 'the oldest must be dropped first')
})

// ------------------------------------------------------------------ attachments

test('images are classified as inline-capable', () => {
  assert.equal(classify('image/png'), 'image')
  assert.equal(classify('image/jpeg'), 'image')
  assert.equal(classify('text/markdown'), 'text')
  assert.equal(classify('application/pdf'), 'document')
  assert.equal(classify('application/zip'), 'unsupported')
})

test('an image attachment is stored and can be read back inline', (t) => {
  const { dir, req } = setup(t)
  const service = new AttachmentService({ store: req, dataDir: path.join(dir, 'data') })
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const result = service.add({ projectId: 'proj-a', filename: 'shot.png', mime: 'image/png', buffer: png })
  assert.equal(result.ok, true, result.detail)
  assert.equal(result.inline, true)

  const inline = service.readForInline('proj-a', result.attachment.id)
  assert.equal(inline.ok, true)
  assert.equal(Buffer.from(inline.data, 'base64').toString('hex'), png.toString('hex'))
})

test('an attachment cannot be read from another project', (t) => {
  const { dir, req } = setup(t)
  const service = new AttachmentService({ store: req, dataDir: path.join(dir, 'data') })
  const result = service.add({ projectId: 'proj-a', filename: 'a.png', mime: 'image/png', buffer: Buffer.from('x') })
  assert.equal(result.ok, true)
  const stolen = service.readForInline('proj-b', result.attachment.id)
  assert.equal(stolen.ok, false)
  assert.match(String(stolen.detail), /不属于该项目/)
})

test('an unsupported type is refused with a readable reason', (t) => {
  const { dir, req } = setup(t)
  const service = new AttachmentService({ store: req, dataDir: path.join(dir, 'data') })
  const result = service.add({ projectId: 'proj-a', filename: 'a.zip', mime: 'application/zip', buffer: Buffer.from('x') })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNSUPPORTED')
})

test('a text file is stored with its text extracted', (t) => {
  const { dir, req } = setup(t)
  const service = new AttachmentService({ store: req, dataDir: path.join(dir, 'data') })
  const result = service.add({ projectId: 'proj-a', filename: 'notes.md', mime: 'text/markdown', buffer: Buffer.from('# 玩法\n自动攻击') })
  assert.equal(result.ok, true)
  assert.match(result.attachment.extractedText, /自动攻击/)
})

test('a PDF with no text layer is refused rather than stored empty', (t) => {
  const { dir, req } = setup(t)
  const service = new AttachmentService({ store: req, dataDir: path.join(dir, 'data') })
  const result = service.add({ projectId: 'proj-a', filename: 'scan.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4 no text here') })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXTRACTION_FAILED')
})

test('a PDF with a text layer yields its text', () => {
  const pdf = Buffer.from('%PDF-1.4\nBT (Hello Game Design) Tj ET\n', 'latin1')
  const extracted = extractText(pdf, 'application/pdf')
  assert.match(extracted.text, /Hello Game Design/)
  assert.match(extracted.note, /版式与图片丢失/)
})

// ------------------------------------------------------------------ baselines

const content = (overrides = {}) => ({
  name: '鸽子幸存者 v1',
  summary: '像素风微信小游戏',
  sections: [
    { id: 'core', title: '核心玩法', body: '自动攻击 + 波次生存', confirmed: true },
    { id: 'art', title: '美术风格', body: '像素风', confirmed: false },
  ],
  scope: ['核心循环', '波次系统'],
  outOfScope: ['多人联机'],
  openQuestions: ['是否需要 Boss'],
  risks: ['数值平衡'],
  milestones: ['M1 可玩原型'],
  acceptance: ['能连续生存 5 分钟'],
  sources: [{ kind: 'draft', label: '设计草稿 v2', ref: 'draft-1' }],
  ...overrides,
})

test('a preview shows unconfirmed sections and open questions without writing anything', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  const preview = service.preview('proj-a', content())
  assert.deepEqual(preview.unconfirmed, ['美术风格'])
  assert.deepEqual(preview.openQuestions, ['是否需要 Boss'])
  assert.ok(preview.consequences.some((c) => c.includes('不可再修改')))
  assert.equal(service.list('proj-a').length, 0, 'a preview must not create a baseline')
})

test('freezing without a confirmation is refused', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  assert.throws(() => service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: '' }), /BASELINE_NOT_CONFIRMED/)
  assert.equal(service.list('proj-a').length, 0)
})

test('freezing stores the content and its hash', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  const baseline = service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })
  assert.equal(baseline.version, 1)
  assert.equal(baseline.status, 'FROZEN')
  assert.equal(baseline.contentHash.length, 64)
  assert.match(baseline.content, /核心玩法/)
})

test('the second freeze diffs against the first', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })

  const changed = content({
    sections: [
      { id: 'core', title: '核心玩法', body: '自动攻击 + 波次生存 + Boss', confirmed: true },
      { id: 'art', title: '美术风格', body: '像素风', confirmed: true },
      { id: 'audio', title: '音效', body: '8-bit', confirmed: false },
    ],
  })
  const preview = service.preview('proj-a', changed)
  assert.deepEqual(preview.diff.added, ['音效'])
  assert.deepEqual(preview.diff.changed.sort(), ['核心玩法'])
})

test('a change proposal records an impact analysis that names its own gaps', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  const baseline = service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })
  const proposal = service.proposeChange({
    projectId: 'proj-a',
    baselineId: baseline.id,
    title: '加 Boss',
    description: '核心玩法需要加入 Boss 战',
  })
  assert.equal(proposal.status, 'PENDING')
  assert.ok(proposal.impact.sections.includes('核心玩法'))
  assert.ok(proposal.impact.notAnalyzed.length >= 3, 'the analysis must state what it did not cover')
  assert.ok(proposal.impact.notAnalyzed.some((x) => x.includes('关键词匹配')))
})

test('an approved proposal does not rewrite the frozen baseline', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  const baseline = service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })
  const proposal = service.proposeChange({ projectId: 'proj-a', baselineId: baseline.id, title: 'x', description: '核心玩法' })
  service.decide({ projectId: 'proj-a', proposalId: proposal.id, status: 'APPROVED', decidedBy: 'user' })

  const after = service.get('proj-a', baseline.id)
  assert.equal(after.contentHash, baseline.contentHash, 'approval alone must not change the baseline')
})

test('a rejected proposal leaves the baseline untouched', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  const baseline = service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })
  const proposal = service.proposeChange({ projectId: 'proj-a', baselineId: baseline.id, title: 'x', description: '核心玩法' })
  const decided = service.decide({ projectId: 'proj-a', proposalId: proposal.id, status: 'REJECTED', decidedBy: 'user', note: '不做' })
  assert.equal(decided.status, 'REJECTED')
  assert.equal(service.get('proj-a', baseline.id).contentHash, baseline.contentHash)
})

test('a proposal cannot be decided without a user', (t) => {
  const { req } = setup(t)
  const service = new BaselineService(req)
  const baseline = service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })
  const proposal = service.proposeChange({ projectId: 'proj-a', baselineId: baseline.id, title: 'x', description: 'y' })
  assert.throws(() => service.decide({ projectId: 'proj-a', proposalId: proposal.id, status: 'APPROVED', decidedBy: '' }), /PROPOSAL_NOT_DECIDED/)
})
