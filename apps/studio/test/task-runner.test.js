/**
 * TaskRunner against a scripted runtime.
 *
 * These are labelled fault-injection tests: the "runtime" is a stub that lets us force
 * outcomes a real DSH cannot produce on demand (a run that ends with no events, a resume
 * that fails, a runtime that dies mid-task). The real-runtime path is covered separately
 * in task-integration.test.js.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { TaskRunner } = require('../dist/main/tasks/runner.js')

const ACCEPTANCE = { requireCompletedRun: true, requireResponse: true, requiredTools: [] }

/**
 * A runtime that records what was asked of it and can be scripted per test.
 * releasing the lease makes the pending observation fail, which is what closing a real
 * runtime looks like from the runner's point of view.
 */
function makeRuntime(script = {}) {
  const state = {
    prompts: [],
    resumed: [],
    releaseCalls: 0,
    rejectNext: null,
  }

  function makeSubscription() {
    const queue = []
    let waiter = null
    let closed = false
    const push = (value) => {
      if (closed) return
      if (waiter) {
        const resolve = waiter
        waiter = null
        resolve(value)
      } else queue.push(value)
    }
    state.push = push
    /** Simulate the runtime dying: the pending observation rejects, like a real one does. */
    state.die = () => {
      if (state.rejectNext) state.rejectNext(new Error('runtime exited'))
    }
    return {
      next() {
        if (closed) return Promise.reject(new Error('subscription closed'))
        if (queue.length > 0) return Promise.resolve(queue.shift())
        return new Promise((resolve, reject) => {
          waiter = resolve
          state.rejectNext = reject
        })
      },
      close() {
        closed = true
        if (state.rejectNext) state.rejectNext(new Error('runtime closed'))
      },
    }
  }

  const client = {
    async prompt(sessionId, blocks) {
      state.prompts.push({ sessionId, blocks })
      if (script.onPrompt) script.onPrompt(state, sessionId)
      return 'msg-1'
    },
    async resumeSession(sessionId) {
      state.resumed.push(sessionId)
      if (script.resumeError) throw new Error(script.resumeError)
    },
    subscribeSessionTree() {
      return makeSubscription()
    },
    subscribe() {
      return makeSubscription()
    },
    start() {},
    async initialize() {
      return { serverInfo: { name: 'stub', version: '0' } }
    },
    async close() {},
  }

  const supervisor = new EventEmitter()
  supervisor.snapshot = () => []
  supervisor.acquire = async () => {
    const lease = {
      runtimeId: 'rt-test',
      isolation: 'writable',
      client,
      released: false,
      bindSession() {},
      async release() {
        state.releaseCalls += 1
        lease.released = true
        if (state.rejectNext) state.rejectNext(new Error('runtime closed'))
      },
    }
    return lease
  }
  supervisor.shutdownAll = async () => ({ closed: ['rt-test'], failed: [] })
  return { supervisor, client, state }
}

function harness(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runner-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const runtime = makeRuntime(script)
  const events = []
  const logger = {
    info: (event, fields) => events.push({ event, fields }),
    warn: (event, fields) => events.push({ event, fields }),
    error: (event, fields) => events.push({ event, fields }),
  }
  const runner = new TaskRunner({
    store,
    supervisor: runtime.supervisor,
    logger,
    recordsDir: path.join(dir, 'records'),
    runTimeoutMs: 5000,
  })
  const task = store.createTask({
    id: 'task-1',
    title: 'Test task',
    goal: 'do the thing',
    type: 'analysis',
    isolation: 'writable',
    acceptance: ACCEPTANCE,
  })
  return { dir, store, runner, runtime, events, task }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 30))
  }
  return null
}

test('a run that ends with evidence reaches SUCCEEDED through VERIFYING', async (t) => {
  const { store, runner, runtime, task } = harness(t, {
    onPrompt(state) {
      setTimeout(() => {
        state.push({ method: 'session.event', params: { sessionId: 's', event: { type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } } })
        state.push({ method: 'session.status', params: { status: 'idle' } })
      }, 10)
    },
  })
  await runner.start(task.id)
  const final = await waitFor(() => {
    const current = store.getTask(task.id)
    return ['SUCCEEDED', 'FAILED'].includes(current.status) ? current : null
  })
  assert.ok(final, 'the task must settle')
  assert.equal(final.status, 'SUCCEEDED')
  assert.equal(store.listTransitions(task.id).map((row) => row.to).join('>'), 'CREATED>QUEUED>PREPARING>RUNNING>VERIFYING>SUCCEEDED')
  assert.equal(store.listVerifications(task.id)[0].ok, true)
  assert.equal(runtime.state.prompts.length, 1)
})

test('a run with no evidence is not success, whatever the model says', async (t) => {
  const { store, runner, runtime, task } = harness(t, {
    onPrompt(state) {
      setTimeout(() => state.push({ method: 'session.status', params: { status: 'idle' } }), 10)
    },
  })
  await runner.start(task.id)
  const final = await waitFor(() => {
    const current = store.getTask(task.id)
    return ['SUCCEEDED', 'FAILED'].includes(current.status) ? current : null
  })
  assert.equal(final.status, 'FAILED')
  assert.equal(final.lastErrorCode, 'NO_EVENTS')
  const verification = store.listVerifications(task.id)[0]
  assert.equal(verification.ok, false)
  assert.equal(runtime.state.prompts.length, 1)
})

test('stop moves through INTERRUPTING to INTERRUPTED and releases the runtime', async (t) => {
  const { store, runner, runtime, task } = harness(t, { onPrompt() {} })
  await runner.start(task.id)
  assert.ok(await waitFor(() => store.getTask(task.id).status === 'RUNNING'), 'should be running')

  await runner.stop(task.id)
  // stop() waits for the runtime release, so the task may already have settled; what
  // matters is that it passed through INTERRUPTING on the way (checked via history below).
  const settled = await waitFor(() => {
    const status = store.getTask(task.id).status
    return status === 'INTERRUPTED' || status === 'FAILED' ? status : null
  })
  assert.equal(settled, 'INTERRUPTED')
  const path = store.listTransitions(task.id).map((row) => row.to)
  assert.ok(path.includes('INTERRUPTING'), 'the task must pass through INTERRUPTING: ' + path.join('>'))
  assert.ok(runtime.state.releaseCalls >= 1, 'stopping must release the runtime')
})

test('a second stop is a no-op rather than a second close', async (t) => {
  const { store, runner, runtime, task } = harness(t, { onPrompt() {} })
  await runner.start(task.id)
  await waitFor(() => store.getTask(task.id).status === 'RUNNING')
  await runner.stop(task.id)
  await waitFor(() => store.getTask(task.id).status === 'INTERRUPTED')
  const before = runtime.state.releaseCalls
  await runner.stop(task.id)
  assert.equal(runtime.state.releaseCalls, before, 'the second stop must not close again')
})

test('resume reuses the persisted session and records a new attempt', async (t) => {
  const { store, runner, runtime, task } = harness(t, {
    // The first run is interrupted before it finishes; only the resumed run goes idle.
    onPrompt(state) {
      if (state.prompts.length < 2) return
      setTimeout(() => {
        state.push({ method: 'session.event', params: { event: { type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'resumed fine' }] } } } })
        state.push({ method: 'session.status', params: { status: 'idle' } })
      }, 10)
    },
  })
  await runner.start(task.id)
  await waitFor(() => store.getTask(task.id).status === 'RUNNING')
  await runner.stop(task.id)
  await waitFor(() => store.getTask(task.id).status === 'INTERRUPTED')

  const sessionBefore = store.listSessions(task.id)[0].id
  await runner.resume(task.id)
  const settled = await waitFor(() => {
    const status = store.getTask(task.id).status
    return ['SUCCEEDED', 'FAILED'].includes(status) ? status : null
  })
  assert.equal(settled, 'SUCCEEDED')
  assert.deepEqual(runtime.state.resumed, [sessionBefore], 'resume must ask DSH for the same session')
  const attempts = store.listAttempts(task.id)
  assert.equal(attempts.length, 2, 'a resume is a new attempt')
  assert.equal(attempts[1].sessionId, sessionBefore)
})

test('a failed resume is reported, never hidden behind a new session', async (t) => {
  const { store, runner, task } = harness(t, { resumeError: 'session history is missing' })
  await runner.start(task.id)
  await waitFor(() => store.getTask(task.id).status === 'RUNNING')
  await runner.stop(task.id)
  await waitFor(() => store.getTask(task.id).status === 'INTERRUPTED')

  const before = store.listSessions(task.id).length
  await runner.resume(task.id)
  const settled = await waitFor(() => {
    const status = store.getTask(task.id).status
    return status === 'FAILED' ? status : null
  })
  assert.equal(settled, 'FAILED')
  assert.match(String(store.getTask(task.id).lastErrorMessage), /session history is missing/)
  assert.equal(store.listSessions(task.id).length, before, 'a failed resume must not create a session')
})

test('a runtime that dies moves the task out of RUNNING', async (t) => {
  const { store, runner, runtime, task } = harness(t, { onPrompt() {} })
  await runner.start(task.id)
  await waitFor(() => store.getTask(task.id).status === 'RUNNING')
  runtime.state.die()
  runtime.supervisor.emit('runtime:exited', {
    runtimeId: 'rt-test',
    reason: 'runtime-exited',
    error: 'exit code: 1',
    taskIds: [task.id],
  })
  const settled = await waitFor(() => {
    const status = store.getTask(task.id).status
    return status === 'INTERRUPTED' ? status : null
  })
  assert.equal(settled, 'INTERRUPTED')
  assert.match(String(store.getTask(task.id).lastErrorMessage), /exit code: 1/)
})

test('startup recovery marks unfinished tasks INTERRUPTED, not failed', async (t) => {
  const { store, runner, task } = harness(t, { onPrompt() {} })
  store.transition({ taskId: task.id, to: 'QUEUED', reason: 'start', source: 'user' })
  store.transition({ taskId: task.id, to: 'PREPARING', reason: 'prepare', source: 'scheduler' })
  store.transition({ taskId: task.id, to: 'RUNNING', reason: 'run', source: 'scheduler' })
  const result = await runner.recoverOnStartup()
  assert.deepEqual(result.recovered, [task.id])
  assert.equal(store.getTask(task.id).status, 'INTERRUPTED')
  assert.equal(store.listTransitions(task.id).at(-1).source, 'recovery')
})
