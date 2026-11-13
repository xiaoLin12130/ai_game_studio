/**
 * The step between "approved" and "frozen".
 *
 * An approved change proposal is not a new version. It produces a candidate the user can
 * look at and compare; only an explicit confirmation freezes it. The old baseline keeps its
 * bytes and its hash throughout, and the database still refuses to rewrite it.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore, SCHEMA_VERSION } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { RequirementStore } = require('../dist/main/requirements/store.js')
const { BaselineService } = require('../dist/main/requirements/baseline.js')

const content = (overrides = {}) => ({
  name: '鸽子幸存者 v1',
  summary: '像素风微信小游戏',
  sections: [
    { id: 'core', title: '核心玩法', body: '自动攻击 + 波次生存', confirmed: true },
    { id: 'art', title: '美术风格', body: '像素风', confirmed: true },
  ],
  scope: ['核心循环'],
  outOfScope: ['多人联机'],
  openQuestions: [],
  risks: [],
  milestones: [],
  acceptance: [],
  sources: [],
  ...overrides,
})

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cand-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const projects = new ProjectStore(store)
  projects.create({ id: 'proj-a', name: 'A', rootPath: fs.mkdtempSync(path.join(dir, 'root-')), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  const req = new RequirementStore(store.db)
  const service = new BaselineService(req)
  const baseline = service.freeze({ projectId: 'proj-a', content: content(), confirmedBy: 'user' })
  return { dir, store, req, service, baseline }
}

const approvedProposal = (service, baseline) => {
  const proposal = service.proposeChange({
    projectId: 'proj-a',
    baselineId: baseline.id,
    title: '加入 Boss 战',
    description: '核心玩法需要加入 Boss 战',
  })
  return service.decide({ projectId: 'proj-a', proposalId: proposal.id, status: 'APPROVED', decidedBy: 'user' })
}

test('the schema is at v4 with the candidate table and the immutability triggers', (t) => {
  const { store } = setup(t)
  assert.equal(SCHEMA_VERSION, 4)
  assert.equal(store.schemaVersion, 4)
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  assert.ok(tables.includes('baseline_candidates'))
  const triggers = store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name)
  for (const name of ['trg_message_immutable_update', 'trg_message_immutable_delete', 'trg_draft_version_immutable_update', 'trg_draft_version_immutable_delete']) {
    assert.ok(triggers.includes(name), 'missing trigger: ' + name)
  }
})

test('B1: rejecting a proposal leaves the baseline untouched', (t) => {
  const { service, baseline } = setup(t)
  const proposal = service.proposeChange({ projectId: 'proj-a', baselineId: baseline.id, title: 'x', description: '核心玩法' })
  service.decide({ projectId: 'proj-a', proposalId: proposal.id, status: 'REJECTED', decidedBy: 'user' })
  assert.equal(service.get('proj-a', baseline.id).contentHash, baseline.contentHash)
  assert.equal(service.list('proj-a').length, 1)
})

test('B2: approving a proposal does not modify the baseline', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  assert.equal(proposal.status, 'APPROVED')
  const after = service.get('proj-a', baseline.id)
  assert.equal(after.content, baseline.content, 'the baseline bytes must not change on approval')
  assert.equal(after.contentHash, baseline.contentHash)
  assert.equal(service.list('proj-a').length, 1, 'approval alone creates no version')
})

test('B3: an approved proposal produces a candidate', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  assert.equal(candidate.proposalId, proposal.id)
  assert.equal(candidate.baselineId, baseline.id)
  assert.equal(candidate.frozenBaselineId, null)
  assert.notEqual(candidate.contentHash, baseline.contentHash, 'the candidate differs from the baseline')
})

test('a pending proposal cannot produce a candidate', (t) => {
  const { service, baseline } = setup(t)
  const proposal = service.proposeChange({ projectId: 'proj-a', baselineId: baseline.id, title: 'x', description: '核心玩法' })
  assert.throws(() => service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id }), /CANDIDATE_NOT_ALLOWED/)
})

test('B4: the candidate diff shows what would change', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  const diff = service.candidateDiff('proj-a', candidate.id)
  assert.ok(diff, 'a diff must be produced')
  assert.ok(diff.changed.includes('核心玩法'), 'the touched section must show as changed: ' + JSON.stringify(diff))
})

test('B5: abandoning a candidate leaves the baseline unchanged', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  const after = service.get('proj-a', baseline.id)
  assert.equal(after.contentHash, baseline.contentHash)
  assert.equal(service.list('proj-a').length, 1, 'no new version exists yet')
})

test('B6/B7: confirming a candidate freezes a new version with a hash and a predecessor', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  const frozen = service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: 'user' })

  assert.equal(frozen.version, 2)
  assert.equal(frozen.status, 'FROZEN')
  assert.equal(frozen.previousBaselineId, baseline.id, 'the new version must point at the one it replaces')
  assert.equal(frozen.contentHash.length, 64)
  assert.notEqual(frozen.contentHash, baseline.contentHash)
  assert.equal(frozen.confirmedBy, 'user')
})

test('B8: the old baseline still refuses direct SQL modification after a new version exists', (t) => {
  const { service, store, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: 'user' })

  assert.throws(
    () => store.db.prepare('UPDATE requirement_baselines SET content = ? WHERE id = ?').run('{}', baseline.id),
    /frozen requirement baseline cannot be modified/,
  )
  assert.throws(
    () => store.db.prepare('DELETE FROM requirement_baselines WHERE id = ?').run(baseline.id),
    /frozen requirement baseline cannot be deleted/,
  )
  assert.equal(service.get('proj-a', baseline.id).contentHash, baseline.contentHash)
})

test('B8: the new version is immutable too', (t) => {
  const { service, store, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  const frozen = service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: 'user' })
  assert.throws(
    () => store.db.prepare('UPDATE requirement_baselines SET name = ? WHERE id = ?').run('renamed', frozen.id),
    /frozen requirement baseline cannot be modified/,
  )
})

test('B9: applying the same proposal twice does not create two versions', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  assert.throws(
    () => service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id }),
    /CANDIDATE_EXISTS/,
  )
  assert.equal(service.listCandidates('proj-a').length, 1)
})

test('freezing a candidate twice is refused', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: 'user' })
  assert.throws(
    () => service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: 'user' }),
    /CANDIDATE_ALREADY_FROZEN/,
  )
  assert.equal(service.list('proj-a').length, 2, 'still exactly two versions')
})

test('freezing a candidate without a confirmation is refused', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  assert.throws(() => service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: '' }), /BASELINE_NOT_CONFIRMED/)
  assert.equal(service.list('proj-a').length, 1)
})

test('the frozen candidate records the baseline it became', (t) => {
  const { service, baseline } = setup(t)
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  const frozen = service.freezeCandidate({ projectId: 'proj-a', candidateId: candidate.id, confirmedBy: 'user' })
  const stored = service.listCandidates('proj-a')[0]
  assert.equal(stored.frozenBaselineId, frozen.id)
})

test('a candidate cannot be frozen for another project', (t) => {
  const { service, baseline, req } = setup(t)
  req // project B does not exist in this fixture; a foreign id must not resolve
  const proposal = approvedProposal(service, baseline)
  const candidate = service.createCandidate({ projectId: 'proj-a', proposalId: proposal.id })
  assert.throws(() => service.freezeCandidate({ projectId: 'proj-b', candidateId: candidate.id, confirmedBy: 'user' }), /unknown candidate/)
})

// ------------------------------------------------------------------ history protection

test('P2-B: a stored message cannot be modified or deleted', (t) => {
  const { store, req } = setup(t)
  const conversation = req.createConversation({ projectId: 'proj-a', title: 'talk' })
  const message = req.appendMessage({ conversationId: conversation.id, role: 'user', kind: 'text', content: 'hello' })

  assert.throws(
    () => store.db.prepare('UPDATE advisor_messages SET content = ? WHERE id = ?').run('rewritten', message.id),
    /stored conversation message cannot be modified/,
  )
  assert.throws(
    () => store.db.prepare('DELETE FROM advisor_messages WHERE id = ?').run(message.id),
    /stored conversation message cannot be deleted/,
  )
  assert.equal(req.getMessage(conversation.id, message.id).content, 'hello')
})

test('P2-B: a saved draft version cannot be modified or deleted', (t) => {
  const { store, req } = setup(t)
  const draft = req.createDraft({ projectId: 'proj-a', kind: 'design', title: 'core', content: 'v1' })
  req.addDraftVersion({ projectId: 'proj-a', draftId: draft.id, content: 'v2' })
  const version = req.listDraftVersions(draft.id).find((entry) => entry.version === 2)

  assert.throws(
    () => store.db.prepare('UPDATE draft_versions SET content = ? WHERE id = ?').run('rewritten', version.id),
    /saved draft version cannot be modified/,
  )
  assert.throws(
    () => store.db.prepare('DELETE FROM draft_versions WHERE id = ?').run(version.id),
    /saved draft version cannot be deleted/,
  )
  assert.equal(req.getDraftVersion(draft.id, 2).content, 'v2')
  assert.equal(req.getDraftVersion(draft.id, 1).content, 'v1', 'the older version is still readable')
})

test('P2-B: normal editing appends a version and never rewrites one', (t) => {
  const { req } = setup(t)
  const draft = req.createDraft({ projectId: 'proj-a', kind: 'design', title: 'core', content: 'first' })
  req.addDraftVersion({ projectId: 'proj-a', draftId: draft.id, content: 'second' })
  req.addDraftVersion({ projectId: 'proj-a', draftId: draft.id, content: 'third' })

  const versions = req.listDraftVersions(draft.id).sort((a, b) => a.version - b.version)
  assert.deepEqual(versions.map((v) => v.content), ['first', 'second', 'third'], 'every version survives')
  assert.equal(req.getDraft('proj-a', draft.id).currentVersion, 3)
})

test('P2-B: messages stay in append order and cannot be renumbered', (t) => {
  const { store, req } = setup(t)
  const conversation = req.createConversation({ projectId: 'proj-a', title: 'talk' })
  req.appendMessage({ conversationId: conversation.id, role: 'user', kind: 'text', content: 'one' })
  req.appendMessage({ conversationId: conversation.id, role: 'assistant', kind: 'text', content: 'two' })

  const messages = req.listMessages(conversation.id)
  assert.deepEqual(messages.map((m) => m.seq), [1, 2])
  assert.throws(
    () => store.db.prepare('UPDATE advisor_messages SET seq = 99 WHERE id = ?').run(messages[0].id),
    /cannot be modified/,
  )
})
