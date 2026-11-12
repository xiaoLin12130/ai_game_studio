/**
 * Lock heartbeat and every release path, through the real runner.
 *
 * Without a heartbeat, a task that legitimately runs longer than staleAfterMs has its lock
 * reclaimed and a second writer let in. These use a short stale window and a task that
 * outlives it, which is the only way to prove the heartbeat is doing anything.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { TaskService } = require('../dist/main/tasks/service.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { ProjectLocks } = require('../dist/main/projects/locks.js')

const ACCEPTANCE = { requireCompletedRun: true, requireResponse: true, requiredTools: [] }

function makeSupervisor(behaviour = {}) {
  const state = { prompts: [], rejectNext: null, acquireError: behaviour.acquireError ?? null, resumeError: behaviour.resumeError ?? null }
  const client = {
    async prompt(sessionId, blocks) { state.prompts.push({ sessionId, blocks }); return 'm' },
    async resumeSession() { if (state.resumeError) throw new Error(state.resumeError) },
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
  supervisor.acquire = async () => {
    if (state.acquireError) throw new Error(state.acquireError)
    return { runtimeId: 'rt-1', isolation: 'writable', client, released: false, bindSession() {}, async release() {} }
  }
  supervisor.shutdownAll = async () => ({ closed: ['rt-1'], failed: [] })
  return { supervisor, state }
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hb-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => { try { store.close() } catch {} })
  const projects = new ProjectStore(store)
  const root = fs.mkdtempSync(path.join(dir, 'game-'))
  const project = projects.create({ id: 'proj-a', name: 'A', rootPath: root, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

  const locks = new ProjectLocks(store.db, { staleAfterMs: options.staleAfterMs ?? 400, isProcessAlive: () => true })
  const { supervisor, state } = makeSupervisor(options)
  const service = new TaskService({
    logger: { info() {}, warn() {}, error() {} },
    userDataDir: dir,
    dshHome: path.join(dir, 'dsh-home'),
    profile: 'sdk',
    provider: 'commandcode',
    model: 'm',
    cwd: dir,
    store,
    supervisor,
    projectLocks: locks,
    projectExists: (id) => Boolean(projects.get(id)),
    runTimeoutMs: options.runTimeoutMs ?? 3000,
  })
  t.after(async () => { await service.dispose('test-end').catch(() => {}) })
  return { dir, store, projects, locks, service, project, state }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 20))
  }
  return null
}

test('the heartbeat updates while a task runs', async (t) => {
  const { service, locks, project } = setup(t, { staleAfterMs: 400 })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  const first = await waitFor(() => locks.current(project.id).write)
  assert.ok(first)

  // The interval is a quarter of the stale window, so a beat lands well inside this wait.
  await new Promise((r) => setTimeout(r, 700))
  const second = locks.current(project.id).write
  assert.ok(second, 'the lock must still be held')
  assert.notEqual(second.heartbeatAt, first.heartbeatAt, 'the heartbeat must have advanced')
})

test('a task running longer than staleAfterMs keeps its lock', async (t) => {
  const { service, locks, project } = setup(t, { staleAfterMs: 400, runTimeoutMs: 2500 })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current(project.id).write)

  // Well past the stale window: without a heartbeat this lock would be reclaimable.
  await new Promise((r) => setTimeout(r, 1200))
  const held = locks.current(project.id).write
  assert.ok(held, 'the lock must survive past staleAfterMs')
  assert.equal(locks.isStale(held), false, 'a heartbeating lock must not look stale')
})

test('the heartbeat stops when the task is stopped', async (t) => {
  const { service, locks, project, store } = setup(t, { staleAfterMs: 400 })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current(project.id).write)

  await service.act(task.id, 'stop')
  await waitFor(() => store.getTask(task.id).status === 'INTERRUPTED')
  assert.equal(locks.current(project.id).write, null, 'stopping must release the lock')

  // No timer may keep firing after release.
  const before = locks.list().length
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(locks.list().length, before, 'no heartbeat may resurrect a released lock')
})

test('the lock is released after success', async (t) => {
  const { service, locks, project, store, state } = setup(t, { staleAfterMs: 400 })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current(project.id).write)

  state.rejectNext?.(new Error('runtime exited'))
  await waitFor(() => ['FAILED', 'INTERRUPTED'].includes(store.getTask(task.id).status))
  assert.equal(locks.current(project.id).write, null)
})

test('the lock is released when the runtime cannot be acquired', async (t) => {
  const { service, locks, project, store } = setup(t, { acquireError: 'runtime start failed' })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  await waitFor(() => store.getTask(task.id).status === 'FAILED')
  assert.equal(locks.current(project.id).write, null, 'a failed runtime start must not keep the lock')
})

test('the lock is released when the session cannot be resumed', async (t) => {
  const { service, locks, project, store, state } = setup(t, { staleAfterMs: 400, resumeError: 'session history is missing' })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current(project.id).write)
  await service.act(task.id, 'stop')
  await waitFor(() => store.getTask(task.id).status === 'INTERRUPTED')

  await service.act(task.id, 'resume')
  await waitFor(() => store.getTask(task.id).status === 'FAILED')
  assert.equal(locks.current(project.id).write, null, 'a failed resume must not keep the lock')
})

test('dispose leaves no lock and no heartbeat behind', async (t) => {
  const { service, locks, project, dir } = setup(t, { staleAfterMs: 400 })
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: project.id })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current(project.id).write)

  await service.dispose('test-end')

  const { TaskStore } = require('../dist/main/tasks/store.js')
  const { ProjectLocks } = require('../dist/main/projects/locks.js')
  const reopened = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => reopened.close())
  assert.equal(new ProjectLocks(reopened.db).list().length, 0, 'no lock may survive shutdown')
})
