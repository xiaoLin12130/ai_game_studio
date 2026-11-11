/**
 * Persistence has to survive a crash and refuse to half-apply a state change.
 * These tests use a real SQLite file in a temp directory, not an in-memory stub.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore, SCHEMA_VERSION } = require('../dist/main/tasks/store.js')

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-'))
  const instance = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => instance.close())
  return instance
}

const acceptance = { requireCompletedRun: true, requireResponse: true, requiredTools: [] }

function seed(s, id = 'task-a') {
  return s.createTask({ id, title: 'Analyse the project', goal: 'Look at the project', type: 'analysis', isolation: 'readonly', acceptance })
}

test('the schema is created at the expected version', (t) => {
  const s = store(t)
  assert.equal(s.schemaVersion, SCHEMA_VERSION)
})

test('a task starts in CREATED and can move on', (t) => {
  const s = store(t)
  const task = seed(s)
  assert.equal(task.status, 'CREATED')
  const queued = s.transition({ taskId: task.id, to: 'QUEUED', reason: 'user started', source: 'user' })
  assert.equal(queued.status, 'QUEUED')
  const history = s.listTransitions(task.id)
  assert.equal(history.length, 2, 'creation plus the move')
  assert.deepEqual(history.map((row) => row.to), ['CREATED', 'QUEUED'])
})

test('an illegal move is refused and nothing is written', (t) => {
  const s = store(t)
  const task = seed(s)
  assert.throws(
    () => s.transition({ taskId: task.id, to: 'SUCCEEDED', reason: 'cheating', source: 'system' }),
    /illegal task transition/,
  )
  assert.equal(s.getTask(task.id).status, 'CREATED')
  assert.equal(s.listTransitions(task.id).length, 1, 'a refused move must not leave a history row')
})

test('attempt numbers are unique per task', (t) => {
  const s = store(t)
  const task = seed(s)
  s.createAttempt({ id: 'att-1', taskId: task.id, attemptNo: 1 })
  assert.throws(() => s.createAttempt({ id: 'att-1b', taskId: task.id, attemptNo: 1 }), /UNIQUE|constraint/i)
  assert.equal(s.nextAttemptNo(task.id), 2)
})

test('an attempt, its session and the task stay linked', (t) => {
  const s = store(t)
  const task = seed(s)
  s.transition({ taskId: task.id, to: 'QUEUED', reason: 'start', source: 'user' })
  const attempt = s.createAttempt({ id: 'att-1', taskId: task.id, attemptNo: 1, sessionId: 'sess-1', runtimeId: 'rt-1' })
  s.upsertSession({ id: 'sess-1', taskId: task.id, attemptId: attempt.id, runtimeId: 'rt-1', state: 'ACTIVE' })
  const view = s.getTaskView(task.id)
  assert.equal(view.attempts.length, 1)
  assert.equal(view.sessions.length, 1)
  assert.equal(view.sessions[0].id, 'sess-1')
  assert.equal(view.attempts[0].sessionId, 'sess-1')
})

test('state survives reopening the database', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-reopen-'))
  const dbPath = path.join(dir, 'studio.db')
  const first = new TaskStore(dbPath)
  const task = seed(first, 'task-persist')
  first.transition({ taskId: task.id, to: 'QUEUED', reason: 'start', source: 'user' })
  first.close()

  const second = new TaskStore(dbPath)
  t.after(() => second.close())
  const reloaded = second.getTask('task-persist')
  assert.equal(reloaded.status, 'QUEUED')
  assert.equal(second.listTransitions('task-persist').length, 2)
})

test('unfinished tasks are the ones a restart has to reconcile', (t) => {
  const s = store(t)
  const running = seed(s, 'task-running')
  s.transition({ taskId: running.id, to: 'QUEUED', reason: 'start', source: 'user' })
  s.transition({ taskId: running.id, to: 'PREPARING', reason: 'prepare', source: 'scheduler' })
  s.transition({ taskId: running.id, to: 'RUNNING', reason: 'run', source: 'scheduler' })
  const done = seed(s, 'task-done')
  s.transition({ taskId: done.id, to: 'QUEUED', reason: 'start', source: 'user' })
  s.transition({ taskId: done.id, to: 'PREPARING', reason: 'prepare', source: 'scheduler' })
  s.transition({ taskId: done.id, to: 'RUNNING', reason: 'run', source: 'scheduler' })
  s.transition({ taskId: done.id, to: 'VERIFYING', reason: 'run finished', source: 'runtime' })
  s.transition({ taskId: done.id, to: 'SUCCEEDED', reason: 'verified', source: 'verifier' })

  const unfinished = s.listUnfinished().map((task) => task.id)
  assert.deepEqual(unfinished, ['task-running'])
})

test('verification results are recorded in order', (t) => {
  const s = store(t)
  const task = seed(s)
  s.recordVerification({ taskId: task.id, attemptId: 'att-1', ok: false, code: 'NO_RESPONSE', detail: 'nothing came back' })
  s.recordVerification({ taskId: task.id, attemptId: 'att-2', ok: true })
  const rows = s.listVerifications(task.id)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ok, false)
  assert.equal(rows[1].ok, true)
})
