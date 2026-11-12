/**
 * Project locks through the real TaskService/TaskRunner call chain.
 *
 * The lock class already had its own tests; what was missing was proof that a task actually
 * takes the lock. These drive TaskService.act() and observe the lock table, so a regression
 * that removes the integration fails here rather than passing on the unit tests alone.
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

/** A runtime that stays running until the test releases it. */
function makeSupervisor() {
  const state = { prompts: [], releases: 0, rejectNext: null }
  const client = {
    async prompt(sessionId, blocks) {
      state.prompts.push({ sessionId, blocks })
      return 'msg-1'
    },
    async resumeSession() {},
    subscribeSessionTree() {
      return {
        next: () => new Promise((resolve, reject) => { state.rejectNext = reject }),
        close() { if (state.rejectNext) state.rejectNext(new Error('closed')) },
      }
    },
    subscribe() { return this.subscribeSessionTree() },
    start() {},
    async initialize() { return { serverInfo: { name: 'stub', version: '0' } } },
    async close() {},
  }
  const supervisor = new EventEmitter()
  supervisor.snapshot = () => []
  supervisor.acquire = async () => ({
    runtimeId: 'rt-1',
    isolation: 'writable',
    client,
    released: false,
    bindSession() {},
    async release() { state.releases += 1 },
  })
  supervisor.shutdownAll = async () => ({ closed: ['rt-1'], failed: [] })
  return { supervisor, state }
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tasklock-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const projects = new ProjectStore(store)
  const mkProject = (id, name) => {
    const root = fs.mkdtempSync(path.join(dir, 'root-' + id + '-'))
    return projects.create({ id, name, rootPath: root, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  }
  mkProject('proj-a', 'A')
  mkProject('proj-b', 'B')

  const locks = new ProjectLocks(store.db)
  const { supervisor, state } = makeSupervisor()
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
    // The stub runtime never goes idle, so a short bound keeps each test quick while still
    // exercising the real timeout path.
    runTimeoutMs: 1500,
  })
  t.after(async () => {
    // A task left RUNNING holds a subscription; without this the test process never exits.
    await service.dispose('test-end').catch(() => {})
  })
  return { dir, store, projects, locks, service, state }
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

test('a writable task with a project takes the write lock', async (t) => {
  const { service, locks, store } = setup(t)
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  assert.equal(store.getTask(task.id).projectId, 'proj-a', 'the project must reach the database')

  await service.act(task.id, 'start')
  const held = await waitFor(() => locks.current('proj-a').write)
  assert.ok(held, 'the task must hold the project write lock while running')
  assert.equal(held.ownerId, task.id)
})

test('a second writable task on the same project is refused before a runtime starts', async (t) => {
  const { service, locks, store, state } = setup(t)
  const first = service.create({ title: 'a', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  await service.act(first.id, 'start')
  await waitFor(() => locks.current('proj-a').write)

  const second = service.create({ title: 'b', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  await service.act(second.id, 'start')
  const failed = await waitFor(() => {
    const task = store.getTask(second.id)
    return task.status === 'FAILED' ? task : null
  })
  assert.ok(failed, 'the second writer must fail')
  assert.equal(failed.lastErrorCode, 'PROJECT_LOCKED')
  assert.equal(state.prompts.length, 1, 'the second task must not have reached the runtime')
})

test('writable tasks on different projects run in parallel', async (t) => {
  const { service, locks } = setup(t)
  const a = service.create({ title: 'a', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  const b = service.create({ title: 'b', goal: 'g', isolation: 'writable', projectId: 'proj-b' })
  await service.act(a.id, 'start')
  await service.act(b.id, 'start')
  assert.ok(await waitFor(() => locks.current('proj-a').write), 'A must hold its lock')
  assert.ok(await waitFor(() => locks.current('proj-b').write), 'B must hold its lock')
})

test('read-only tasks do not take the write lock and may run together', async (t) => {
  const { service, locks } = setup(t)
  const a = service.create({ title: 'a', goal: 'g', isolation: 'readonly', projectId: 'proj-a' })
  const b = service.create({ title: 'b', goal: 'g', isolation: 'readonly', projectId: 'proj-a' })
  await service.act(a.id, 'start')
  await service.act(b.id, 'start')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(locks.current('proj-a').write, null, 'read-only work must not hold the write lock')
})

test('the lock is released when the task is stopped', async (t) => {
  const { service, locks, store } = setup(t)
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current('proj-a').write)

  await service.act(task.id, 'stop')
  await waitFor(() => store.getTask(task.id).status === 'INTERRUPTED')
  assert.equal(locks.current('proj-a').write, null, 'stopping must release the lock')
})

test('the lock is released when the task fails', async (t) => {
  const { service, locks, store, state } = setup(t)
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current('proj-a').write)

  // Make the run fail the way a dead runtime would.
  state.rejectNext?.(new Error('runtime exited'))
  await waitFor(() => ['FAILED', 'INTERRUPTED'].includes(store.getTask(task.id).status))
  assert.equal(locks.current('proj-a').write, null, 'a failed task must not keep the lock')
})

test('a task with no project keeps the PHASE 01-C behaviour', async (t) => {
  const { service, locks, store } = setup(t)
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable' })
  assert.equal(store.getTask(task.id).projectId, null)
  await service.act(task.id, 'start')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(locks.list().length, 0, 'a project-less task must not take any project lock')
})

test('an unknown project is refused at creation', (t) => {
  const { service } = setup(t)
  assert.throws(() => service.create({ title: 't', goal: 'g', projectId: 'proj-missing' }), /unknown project/)
})

test('dispose releases every project lock the runner holds', async (t) => {
  const { service, locks, dir } = setup(t)
  const task = service.create({ title: 't', goal: 'g', isolation: 'writable', projectId: 'proj-a' })
  await service.act(task.id, 'start')
  await waitFor(() => locks.current('proj-a').write)

  // dispose() closes the database, so the lock table has to be read before it runs.
  const before = locks.list().length
  assert.equal(before, 1, 'the task should hold one lock before shutdown')

  await service.dispose('test-end')

  // dispose() closes the connection, so reopen the same file and check the row is gone
  // rather than merely unreachable.
  const { TaskStore } = require('../dist/main/tasks/store.js')
  const { ProjectLocks } = require('../dist/main/projects/locks.js')
  const reopened = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => reopened.close())
  assert.equal(new ProjectLocks(reopened.db).list().length, 0, 'shutdown must not leave project locks behind')
})
