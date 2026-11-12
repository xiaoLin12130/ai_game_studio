/**
 * Rule reading through the controlled service.
 *
 * The renderer never reads a file; it asks for a named source. These tests pin the two
 * properties that matter: a missing file is reported as missing rather than as empty text,
 * and a project rule cannot be read from outside the project root.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RulesService, RULE_SOURCES } = require('../dist/main/projects/rules.js')

function setup(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rules-repo-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rules-proj-'))
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(project, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(repo, 'memory-bank'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'state'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Global rules\nbe careful\n')
  fs.writeFileSync(path.join(repo, 'memory-bank', 'handoff.md'), '# Handoff\n')
  fs.writeFileSync(path.join(repo, 'state', 'project_state.json'), JSON.stringify({ current_phase: 'PHASE_01_D', status: 'IN_PROGRESS' }))
  return { repo, project, service: new RulesService({ repoRoot: repo, projectRoot: project }) }
}

test('global rules are readable and carry their scope', (t) => {
  const { service } = setup(t)
  const doc = service.read('agents')
  assert.equal(doc.exists, true)
  assert.equal(doc.scope, 'global')
  assert.match(doc.content, /be careful/)
})

test('a missing rule file is reported as missing, not as empty content', (t) => {
  const { service } = setup(t)
  const doc = service.read('decisions')
  assert.equal(doc.exists, false)
  assert.equal(doc.content, null)
  assert.equal(doc.error, null, 'a missing optional file is not an error')
})

test('an unknown source is refused with a code', (t) => {
  const { service } = setup(t)
  const doc = service.read('not-a-source')
  assert.match(String(doc.error), /UNKNOWN_SOURCE/)
})

test('project rules are read from the project root', (t) => {
  const { service, project } = setup(t)
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project rules\nthis game only\n')
  const doc = service.read('project-agents')
  assert.equal(doc.exists, true)
  assert.equal(doc.scope, 'project')
  assert.match(doc.content, /this game only/)
})

test('with no project open, project rules say so instead of reading the repo', (t) => {
  const { repo } = setup(t)
  const service = new RulesService({ repoRoot: repo, projectRoot: null })
  const doc = service.read('project-agents')
  assert.equal(doc.exists, false)
  assert.match(String(doc.error), /NO_PROJECT/)
})

test('a large file is truncated and says so', (t) => {
  const { service, repo } = setup(t)
  fs.writeFileSync(path.join(repo, 'README.md'), 'x'.repeat(70 * 1024))
  const doc = service.read('readme')
  assert.equal(doc.truncated, true)
  assert.equal(doc.bytes, 70 * 1024)
  assert.equal(doc.content.length, 64 * 1024)
})

test('the phase and status come from the state file', (t) => {
  const { service } = setup(t)
  const state = service.projectState()
  assert.equal(state.phase, 'PHASE_01_D')
  assert.equal(state.status, 'IN_PROGRESS')
  assert.equal(state.error, null)
})

test('a malformed state file is reported, not guessed', (t) => {
  const { service, repo } = setup(t)
  fs.writeFileSync(path.join(repo, 'state', 'project_state.json'), '{ not json')
  const state = service.projectState()
  assert.equal(state.phase, null)
  assert.match(String(state.error), /not valid JSON/)
})

test('every declared source is listed and readable without throwing', (t) => {
  const { service } = setup(t)
  const all = service.readAll()
  assert.equal(all.length, RULE_SOURCES.length)
  for (const doc of all) {
    assert.equal(typeof doc.id, 'string')
    assert.ok(['global', 'project'].includes(doc.scope))
  }
})
