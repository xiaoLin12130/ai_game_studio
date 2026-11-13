/**
 * Research: state flow, the difference between a tool result and a model's claim, and what
 * happens when the runtime fails.
 *
 * The rule under test: a source is something a tool returned. A model can write a convincing
 * URL, and a report that cites it would look researched while being fabricated.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { RequirementStore } = require('../dist/main/requirements/store.js')
const { ResearchService, parseReport } = require('../dist/main/requirements/research.js')
const { sourcesFromToolTraffic, urlsIn } = require('../dist/main/requirements/research-executor.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-research-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const projects = new ProjectStore(store)
  projects.create({ id: 'proj-a', name: 'A', rootPath: fs.mkdtempSync(path.join(dir, 'root-')), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  projects.create({ id: 'proj-b', name: 'B', rootPath: fs.mkdtempSync(path.join(dir, 'root2-')), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  return { dir, req: new RequirementStore(store.db) }
}

function serviceWith(req, runResearch) {
  return new ResearchService({ store: req, logger: { info() {}, warn() {}, error() {} }, runResearch })
}

// ------------------------------------------------------------------ state flow

test('a request starts REQUESTED and becomes COMPLETED on success', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({
    ok: true,
    markdown: '## 已验证事实\n- 自动攻击',
    sources: [{ title: 'A', url: 'https://example.com/a', fetchedAt: '2026-01-01', via: 'search', note: null, verified: true, status: 'ok' }],
    error: null,
  }))

  const request = service.createRequest({ projectId: 'proj-a', question: '幸存者的核心循环' })
  assert.equal(request.status, 'REQUESTED')

  const result = await service.run('proj-a', request.id)
  assert.equal(result.ok, true)
  assert.equal(req.getResearchRequest('proj-a', request.id).status, 'COMPLETED')
  assert.equal(result.report.sources.length, 1)
})

test('a failed run is FAILED and produces no report', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({ ok: false, markdown: '', sources: [], error: '模型调用失败' }))

  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  const result = await service.run('proj-a', request.id)

  assert.equal(result.ok, false)
  assert.equal(result.report, null, 'a failed run must not leave a report behind')
  assert.equal(req.getResearchRequest('proj-a', request.id).status, 'FAILED')
  assert.equal(req.listResearchReports('proj-a').length, 0)
})

test('a run that throws is FAILED, not completed', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => { throw new Error('runtime died') })
  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  const result = await service.run('proj-a', request.id)
  assert.equal(result.ok, false)
  assert.equal(req.getResearchRequest('proj-a', request.id).status, 'FAILED')
  assert.equal(req.listResearchReports('proj-a').length, 0)
})

test('a report with no verified source carries a notice saying so', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({
    ok: true,
    markdown: '## 已验证事实\n- 模型编的内容',
    sources: [],
    error: null,
    hasVerifiedSources: false,
  }))
  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  const result = await service.run('proj-a', request.id)
  assert.equal(result.ok, true)
  assert.match(result.report.content, /没有获得可验证的外部来源/)
  assert.match(result.report.content, /未经外部核实/)
})

test('a report that cites nothing does not claim verified facts', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({
    ok: true,
    markdown: '## 未验证信息\n- 我没有联网，只能凭记忆',
    sources: [],
    error: null,
  }))
  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  const result = await service.run('proj-a', request.id)
  assert.match(result.report.content, /没有获得可验证的外部来源/)
})

test('an incomplete report names its missing sections', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({ ok: true, markdown: '## 已验证事实\n- 只有这一节', sources: [], error: null }))
  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  const result = await service.run('proj-a', request.id)
  assert.ok(result.incomplete.includes('合理推测'))
  assert.ok(result.incomplete.includes('AI 建议'))
  assert.ok(result.incomplete.includes('需要用户决定'))
})

test('research is project-scoped', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({ ok: true, markdown: '## 已验证事实\n- x', sources: [], error: null }))
  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  await service.run('proj-a', request.id)
  assert.equal(req.listResearchReports('proj-b').length, 0)
})

test('an empty question is refused', (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({ ok: true, markdown: '', sources: [], error: null }))
  assert.throws(() => service.createRequest({ projectId: 'proj-a', question: '  ' }), /具体问题/)
})

// ------------------------------------------------------------------ source provenance

test('a source comes from a tool result, not from the report text', () => {
  const calls = [
    { name: 'web_search', arguments: '{"query":"vampire survivors core loop"}' },
    { name: 'web_fetch', arguments: '{"url":"https://example.com/design"}' },
  ]
  const results = [
    { name: 'web_search', content: 'Results:\n1. Design Analysis https://example.com/design\n2. Other https://other.test/x', ok: true, at: '2026-01-01T00:00:00.000Z' },
    { name: 'web_fetch', content: 'Example Domain — this is the page body', ok: true, at: '2026-01-01T00:00:05.000Z' },
  ]
  const sources = sourcesFromToolTraffic(calls, results)
  const urls = sources.map((s) => s.url)
  assert.ok(urls.includes('https://example.com/design'))
  assert.ok(urls.includes('https://other.test/x'))
  assert.equal(sources.every((s) => s.verified), true, 'a tool-produced URL is verified')
})

test('a URL the model merely wrote is never a source', () => {
  // The model claims two URLs in its report; the tools never returned them.
  const calls = [{ name: 'web_search', arguments: '{"query":"something"}' }]
  const results = [{ name: 'web_search', content: 'no results found', ok: true, at: '2026-01-01T00:00:00.000Z' }]
  const sources = sourcesFromToolTraffic(calls, results)
  assert.equal(sources.length, 0, 'a claim with no tool backing produces no source')
})

test('a failed fetch is recorded as failed, not as a verified source', () => {
  const calls = [{ name: 'web_fetch', arguments: '{"url":"https://example.com/missing"}' }]
  const results = [{ name: 'web_fetch', content: 'HTTP 404', ok: false, at: '2026-01-01T00:00:00.000Z' }]
  const sources = sourcesFromToolTraffic(calls, results)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].verified, false)
  assert.equal(sources[0].status, 'failed')
  assert.match(sources[0].note, /抓取失败/)
})

test('a call with no result produces no source', () => {
  const calls = [{ name: 'web_fetch', arguments: '{"url":"https://example.com/a"}' }]
  const sources = sourcesFromToolTraffic(calls, [])
  assert.equal(sources.length, 0)
})

test('duplicate URLs collapse to one source', () => {
  const calls = [
    { name: 'web_fetch', arguments: '{"url":"https://example.com/a"}' },
    { name: 'web_fetch', arguments: '{"url":"https://example.com/a"}' },
  ]
  const results = [
    { name: 'web_fetch', content: 'body', ok: true, at: '2026-01-01T00:00:00.000Z' },
    { name: 'web_fetch', content: 'body', ok: true, at: '2026-01-01T00:00:01.000Z' },
  ]
  assert.equal(sourcesFromToolTraffic(calls, results).length, 1)
})

test('urlsIn finds URLs and strips trailing punctuation', () => {
  assert.deepEqual(urlsIn('see https://a.test/x, and https://b.test/y.'), ['https://a.test/x', 'https://b.test/y'])
})

test('completion requires an actual report body', async (t) => {
  const { req } = setup(t)
  const service = serviceWith(req, async () => ({ ok: false, markdown: '', sources: [], error: '模型没有返回报告正文。' }))
  const request = service.createRequest({ projectId: 'proj-a', question: 'q' })
  const result = await service.run('proj-a', request.id)
  assert.equal(result.ok, false)
  assert.equal(req.listResearchReports('proj-a').length, 0)
})
