/**
 * The production wiring, tested as the app builds it.
 *
 * The previous round's tests constructed TaskService themselves and passed the lock in by
 * hand — which proved the lock worked but not that the app ever gave it one, and it did not.
 * These call wireServices(), the same function main.ts calls.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { wireServices } = require('../dist/main/app-wiring.js')

const ACCEPTANCE = { requireCompletedRun: true, requireResponse: true, requiredTools: [] }

function makeSupervisor() {
  const state = { prompts: [], rejectNext: null }
  const client = {
    async prompt(sessionId, blocks) { state.prompts.push({ sessionId, blocks }); return 'm' },
    async resumeSession() {},
    subscribeSessionTree() {
      return { next: () => new Promise((resolve, reject) => { state.rejectNext = reject }), close() { state.rejectNext?.(new Error('closed')) } }
    },
    subscribe() { return this.subscribeSessionTree() },
    start() {},
    async initialize() { return { serverInfo: { name: 'stub', version: '0' } } },
    async close() {},
  }
  const supervisor = new EventEmitter()
  supervisor.snapshot = () => []
  supervisor.acquire = async () => ({ runtimeId: 'rt-1', isolation: 'writable', client, released: false, bindSession() {}, async release() {} })
  supervisor.shutdownAll = async () => ({ closed: ['rt-1'], failed: [] })
  return { supervisor, state }
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-wiring-'))
  const { supervisor, state } = makeSupervisor()
  const app = wireServices({
    logger: { info() {}, warn() {}, error() {} },
    userDataDir: dir,
    dbPath: path.join(dir, 'studio.db'),
    dshHome: path.join(dir, 'dsh-home'),
    profile: 'sdk',
    provider: 'commandcode',
    model: 'm',
    cwd: dir,
    runTimeoutMs: 1500,
    supervisorFactory: () => supervisor,
  })
  t.after(async () => { await app.dispose('test-end').catch(() => {}) })

  const root = fs.mkdtempSync(path.join(dir, 'game-'))
  const project = app.projects.create({ name: 'P', rootPath: root, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  return { dir, app, project, state }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

test('the production wiring gives TaskService a real lock table', (t) => {
  const { app } = setup(t)
  assert.ok(app.tasks.runner, 'runner exists')
  // The lock is the same object the wiring created, not undefined.
  assert.equal(typeof app.locks.acquireWrite, 'function')
  assert.equal(app.locks.staleAfterMs > 0, true)
})

test('projectExists rejects an unknown project in the production wiring', (t) => {
  const { app } = setup(t)
  assert.throws(() => app.tasks.create({ title: 't', goal: 'g', projectId: 'proj-missing' }), /unknown project/)
})

test('a project id from the caller is stored and reaches the database', (t) => {
  const { app, project } = setup(t)
  const task = app.tasks.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  assert.equal(app.store.getTask(task.id).projectId, project.id)
})

test('a writable project task takes the write lock before the runtime starts', async (t) => {
  const { app, project, state } = setup(t)
  const task = app.tasks.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await app.tasks.act(task.id, 'start')
  const held = await waitFor(() => app.locks.current(project.id).write)
  assert.ok(held, 'the lock must be held while the task runs')
  assert.equal(held.ownerId, task.id)
  assert.equal(state.prompts.length, 1)
})

test('a second writer on the same project is refused before a runtime starts', async (t) => {
  const { app, project, state } = setup(t)
  const first = app.tasks.create({ title: 'a', goal: 'g', isolation: 'writable', projectId: project.id })
  await app.tasks.act(first.id, 'start')
  await waitFor(() => app.locks.current(project.id).write)

  const second = app.tasks.create({ title: 'b', goal: 'g', isolation: 'writable', projectId: project.id })
  await app.tasks.act(second.id, 'start')
  const failed = await waitFor(() => {
    const task = app.store.getTask(second.id)
    return task.status === 'FAILED' ? task : null
  })
  assert.ok(failed)
  assert.equal(failed.lastErrorCode, 'PROJECT_LOCKED')
  assert.equal(state.prompts.length, 1, 'the refused task must not reach the runtime')
})

test('writers on different projects run in parallel', async (t) => {
  const { app, project, dir } = setup(t)
  const other = app.projects.create({ name: 'Q', rootPath: fs.mkdtempSync(path.join(dir, 'game2-')), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  const a = app.tasks.create({ title: 'a', goal: 'g', isolation: 'writable', projectId: project.id })
  const b = app.tasks.create({ title: 'b', goal: 'g', isolation: 'writable', projectId: other.id })
  await app.tasks.act(a.id, 'start')
  await app.tasks.act(b.id, 'start')
  assert.ok(await waitFor(() => app.locks.current(project.id).write))
  assert.ok(await waitFor(() => app.locks.current(other.id).write))
})

test('a global task keeps the PHASE 01-C behaviour', async (t) => {
  const { app } = setup(t)
  const task = app.tasks.create({ title: 't', goal: 'g', isolation: 'writable' })
  assert.equal(app.store.getTask(task.id).projectId, null)
  await app.tasks.act(task.id, 'start')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(app.locks.list().length, 0, 'a task with no project takes no project lock')
})

test('the restore guard uses in-flight work, not the active map', async (t) => {
  const { app, project } = setup(t)
  const task = app.tasks.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await app.tasks.act(task.id, 'start')
  await waitFor(() => app.locks.current(project.id).write)
  assert.equal(app.tasks.runner.hasInFlightWork, true, 'a running task counts as in-flight')
})
