/**
 * The requirement store: v3 migration, project isolation, and the frozen-baseline constraint.
 *
 * The constraint that matters most is the one a UI cannot provide: a frozen baseline must be
 * immutable at the storage layer. These tests write to the database directly to prove it,
 * because a disabled button proves nothing.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { TaskStore, SCHEMA_VERSION } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { RequirementStore, hashContent, canonicalise } = require('../dist/main/requirements/store.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-req-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const projects = new ProjectStore(store)
  const mk = (id, name) => projects.create({ id, name, rootPath: fs.mkdtempSync(path.join(dir, 'root-' + id + '-')), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  mk('proj-a', 'A')
  mk('proj-b', 'B')
  return { dir, store, projects, req: new RequirementStore(store.db) }
}

test('the schema is at the current version with the requirement tables', (t) => {
  const { store } = setup(t)
  assert.equal(SCHEMA_VERSION, 4)
  assert.equal(store.schemaVersion, 4)
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  for (const name of ['advisor_conversations', 'advisor_messages', 'advisor_session_links', 'context_snapshots', 'attachments', 'drafts', 'draft_versions', 'research_requests', 'research_reports', 'requirement_baselines', 'change_proposals']) {
    assert.ok(tables.includes(name), 'missing table: ' + name)
  }
})

test('a conversation round-trips with ordered messages', (t) => {
  const { req } = setup(t)
  const conv = req.createConversation({ projectId: 'proj-a', title: '鸽子幸存者' })
  req.appendMessage({ conversationId: conv.id, role: 'user', kind: 'text', content: '我想做一个像素风微信小游戏' })
  req.appendMessage({ conversationId: conv.id, role: 'assistant', kind: 'text', content: '先问一个问题：核心循环是生存还是经营？' })

  const messages = req.listMessages(conv.id)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'])
  assert.deepEqual(messages.map((m) => m.seq), [1, 2], 'ordering must come from seq')
})

test('conversations are isolated per project', (t) => {
  const { req } = setup(t)
  const a = req.createConversation({ projectId: 'proj-a', title: 'A talk' })
  const b = req.createConversation({ projectId: 'proj-b', title: 'B talk' })

  assert.equal(req.getConversation('proj-a', b.id), null, 'another project\'s conversation must not be readable')
  assert.equal(req.getConversation('proj-b', a.id), null)
  assert.equal(req.listConversations('proj-a').length, 1)
})

test('messages cannot be read across conversations', (t) => {
  const { req } = setup(t)
  const a = req.createConversation({ projectId: 'proj-a', title: 'A' })
  const b = req.createConversation({ projectId: 'proj-a', title: 'B' })
  const msg = req.appendMessage({ conversationId: a.id, role: 'user', kind: 'text', content: 'secret' })
  assert.equal(req.getMessage(b.id, msg.id), null)
})

test('a draft keeps every version', (t) => {
  const { req } = setup(t)
  const draft = req.createDraft({ projectId: 'proj-a', kind: 'design', title: '核心玩法', content: 'v1 content' })
  assert.equal(draft.currentVersion, 1)
  req.addDraftVersion({ projectId: 'proj-a', draftId: draft.id, content: 'v2 content', note: '加了波次' })
  req.addDraftVersion({ projectId: 'proj-a', draftId: draft.id, content: 'v3 content' })

  const versions = req.listDraftVersions(draft.id)
  assert.equal(versions.length, 3)
  assert.equal(req.getDraftVersion(draft.id, 1).content, 'v1 content', 'old versions must stay readable')
  assert.equal(req.getDraft('proj-a', draft.id).currentVersion, 3)
})

test('a baseline freezes with a stable hash', (t) => {
  const { req } = setup(t)
  const content = JSON.stringify({ core: 'survivors', platform: 'wechat' })
  const baseline = req.freezeBaseline({ projectId: 'proj-a', name: 'v1', content, confirmedBy: 'user' })
  assert.equal(baseline.version, 1)
  assert.equal(baseline.status, 'FROZEN')
  assert.equal(baseline.contentHash, hashContent(content))
  assert.equal(baseline.previousBaselineId, null)
})

test('the hash does not depend on key order', () => {
  const a = JSON.stringify({ b: 2, a: 1 })
  const b = JSON.stringify({ a: 1, b: 2 })
  assert.notEqual(a, b)
  assert.equal(hashContent(a), hashContent(b), 'canonicalisation must make key order irrelevant')
  assert.equal(canonicalise({ b: 2, a: 1 }), '{"a":1,"b":2}')
})

test('a second freeze becomes version 2 and links to version 1', (t) => {
  const { req } = setup(t)
  const first = req.freezeBaseline({ projectId: 'proj-a', name: 'v1', content: '{"a":1}', confirmedBy: 'user' })
  const second = req.freezeBaseline({ projectId: 'proj-a', name: 'v2', content: '{"a":2}', confirmedBy: 'user' })
  assert.equal(second.version, 2)
  assert.equal(second.previousBaselineId, first.id)
  assert.equal(req.listBaselines('proj-a').length, 2)
  assert.equal(req.getBaseline('proj-a', first.id).content, '{"a":1}', 'the old version must still be readable')
})

test('a frozen baseline cannot be updated, even by direct SQL', (t) => {
  const { req, store } = setup(t)
  const baseline = req.freezeBaseline({ projectId: 'proj-a', name: 'v1', content: '{"a":1}', confirmedBy: 'user' })

  assert.throws(() => req.updateBaseline(), /BASELINE_FROZEN/)
  assert.throws(
    () => store.db.prepare('UPDATE requirement_baselines SET content = ? WHERE id = ?').run('{"a":999}', baseline.id),
    /frozen requirement baseline cannot be modified/,
    'the database trigger must refuse the write, not just the service',
  )
  assert.equal(req.getBaseline('proj-a', baseline.id).content, '{"a":1}')
})

test('a frozen baseline cannot be deleted', (t) => {
  const { req, store } = setup(t)
  const baseline = req.freezeBaseline({ projectId: 'proj-a', name: 'v1', content: '{"a":1}', confirmedBy: 'user' })
  assert.throws(
    () => store.db.prepare('DELETE FROM requirement_baselines WHERE id = ?').run(baseline.id),
    /frozen requirement baseline cannot be deleted/,
  )
  assert.ok(req.getBaseline('proj-a', baseline.id))
})

test('baselines are isolated per project and version numbers are per project', (t) => {
  const { req } = setup(t)
  const a = req.freezeBaseline({ projectId: 'proj-a', name: 'A1', content: '{"a":1}', confirmedBy: 'user' })
  const b = req.freezeBaseline({ projectId: 'proj-b', name: 'B1', content: '{"b":1}', confirmedBy: 'user' })
  assert.equal(a.version, 1)
  assert.equal(b.version, 1, 'each project has its own version sequence')
  assert.equal(req.getBaseline('proj-a', b.id), null)
})

test('a change proposal starts pending and records a decision', (t) => {
  const { req } = setup(t)
  const baseline = req.freezeBaseline({ projectId: 'proj-a', name: 'v1', content: '{"a":1}', confirmedBy: 'user' })
  const proposal = req.createProposal({ projectId: 'proj-a', baselineId: baseline.id, title: '加一个 Boss', description: '每 10 波一个 Boss' })
  assert.equal(proposal.status, 'PENDING')
  assert.equal(proposal.impact, null)

  req.setProposalImpact('proj-a', proposal.id, { sections: ['核心循环'], drafts: ['design-1'], rework: ['波次系统'], risks: ['难度曲线'], notAnalyzed: ['数值平衡'] })
  const decided = req.decideProposal({ projectId: 'proj-a', proposalId: proposal.id, status: 'APPROVED', decidedBy: 'user', note: '同意' })
  assert.equal(decided.status, 'APPROVED')
  assert.deepEqual(decided.impact.notAnalyzed, ['数值平衡'])
  assert.ok(decided.decidedAt)
})

test('an approved proposal does not modify the baseline it targets', (t) => {
  const { req } = setup(t)
  const baseline = req.freezeBaseline({ projectId: 'proj-a', name: 'v1', content: '{"a":1}', confirmedBy: 'user' })
  const proposal = req.createProposal({ projectId: 'proj-a', baselineId: baseline.id, title: 'change', description: 'x' })
  req.decideProposal({ projectId: 'proj-a', proposalId: proposal.id, status: 'APPROVED', decidedBy: 'user' })

  const after = req.getBaseline('proj-a', baseline.id)
  assert.equal(after.content, '{"a":1}', 'approval alone must not rewrite a frozen baseline')
  assert.equal(after.contentHash, baseline.contentHash)
})

test('attachments are project-scoped', (t) => {
  const { req } = setup(t)
  const att = req.createAttachment({ projectId: 'proj-a', filename: 'a.png', mime: 'image/png', bytes: 10, sha256: 'x', kind: 'image', storedPath: 'fixture-a.png' })
  assert.equal(req.getAttachment('proj-b', att.id), null, 'another project must not read this attachment')
  assert.equal(req.listAttachments('proj-b').length, 0)
  assert.equal(req.deleteAttachment('proj-b', att.id), false, 'another project must not delete it')
  assert.ok(req.getAttachment('proj-a', att.id))
})

test('research reports keep their sources', (t) => {
  const { req } = setup(t)
  const request = req.createResearchRequest({ projectId: 'proj-a', question: '吸血鬼幸存者的核心循环是什么' })
  const report = req.createResearchReport({
    projectId: 'proj-a',
    requestId: request.id,
    title: '竞品分析',
    content: '## 已验证事实\n- 自动攻击',
    sources: [{ title: 'Design Analysis', url: 'https://example.com/a', fetchedAt: '2026-11-12T00:00:00.000Z', via: 'search', note: null }],
  })
  assert.equal(report.sources.length, 1)
  assert.equal(report.sources[0].via, 'search')
  assert.equal(req.getResearchReport('proj-b', report.id), null)
})

test('a v2 database migrates to the current version and keeps its projects and tasks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mig3-'))
  const dbPath = path.join(dir, 'studio.db')

  // Build a v2 database by hand: the v1 + v2 tables, schema_version = 2.
  const v2 = new DatabaseSync(dbPath)
  v2.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (2);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, type TEXT NOT NULL,
      isolation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      current_attempt_id TEXT, acceptance TEXT NOT NULL, last_error_code TEXT, last_error_message TEXT, project_id TEXT);
    INSERT INTO tasks VALUES ('old','old','g','analysis','readonly','CREATED','2026-01-01','2026-01-01',NULL,'{}',NULL,NULL,NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, engine TEXT NOT NULL,
      platform TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT);
    INSERT INTO projects VALUES ('p1','Old','fixture-old-root','cocos-creator-3.8.6','wechat-minigame','ACTIVE','2026-01-01','2026-01-01',NULL);
  `)
  v2.close()

  const upgraded = new TaskStore(dbPath)
  t.after(() => upgraded.close())
  assert.equal(upgraded.schemaVersion, 4)
  assert.equal(upgraded.getTask('old').title, 'old', 'existing rows must survive')
  assert.equal(new ProjectStore(upgraded).get('p1').name, 'Old')
  const tables = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  assert.ok(tables.includes('requirement_baselines'))
})
