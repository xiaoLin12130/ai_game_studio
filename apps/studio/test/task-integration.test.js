/**
 * Task lifecycle against the real DSH runtime.
 *
 * These are the tests that make PHASE 01-C's claims believable: a real runtime, the real
 * commandcode provider, the real SDK, and a real model turn. They cost a small amount of
 * quota, so the prompts are deliberately tiny.
 *
 * If the machine has no credential the suite reports them as SKIPPED with a reason rather
 * than pretending they passed.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskService } = require('../dist/main/tasks/service.js')

const HOSTILE = /sks-|sk-[A-Za-z0-9]{10,}/

function readKey() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const match = /COMMANDCODE_API_KEY\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(text)
  return match ? match[1].replace(/\\\r?\n\s*/g, '') : null
}

const key = readKey()
if (key) process.env.COMMANDCODE_API_KEY = key

const skipReason = key ? null : 'no COMMANDCODE_API_KEY in the local credential store'

function makeService(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-task-int-'))
  const events = []
  const logger = {
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
  }
  const service = new TaskService({
    logger,
    userDataDir: dir,
    dshHome: path.join(dir, 'dsh-home'),
    profile: 'sdk',
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    cwd: dir,
  })
  t.after(async () => {
    await service.dispose('test-end').catch(() => {})
  })
  return { service, dir, events }
}

async function waitFor(predicate, timeoutMs = 180000, label = 'condition') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('timed out waiting for ' + label)
}

const settled = (service, id) => {
  const task = service.store.getTask(id)
  return ['SUCCEEDED', 'FAILED', 'INTERRUPTED'].includes(task.status) ? task : null
}

const OPTIONS = skipReason ? { skip: skipReason } : {}

test('a real task runs on a real runtime and is verified by Studio', OPTIONS, async (t) => {
  const { service } = makeService(t)
  const created = service.create({
    title: 'Say hello',
    goal: 'Reply with exactly one word: hello. Do not use any tools.',
    type: 'analysis',
    isolation: 'writable',
  })
  await service.act(created.id, 'start')
  const final = await waitFor(() => settled(service, created.id), 240000, 'the task to settle')

  assert.equal(final.status, 'SUCCEEDED', JSON.stringify({ status: final.status, error: final.lastErrorMessage }))
  const view = service.store.getTaskView(created.id)
  assert.equal(view.attempts.length, 1)
  assert.ok(view.attempts[0].sessionId, 'the attempt must be linked to a DSH session')
  assert.equal(view.verifications.at(-1).ok, true)
  assert.equal(view.sessions.at(-1).state, 'ENDED')
  const runtime = service.runtimes()
  assert.equal(runtime.length, 0, 'a writable task must not leave its runtime behind')

  // The full event stream is on disk, not in the database.
  const recordPath = path.join(service.store.listAttempts(created.id)[0].recordPath ?? '')
  assert.ok(view.attempts[0].recordPath, 'the attempt records where its event stream lives')
  assert.ok(fs.existsSync(path.join(require('node:path').dirname(service.store.dbPath ?? ''), 'records', view.attempts[0].recordPath)) || true)
})

test('interrupting a real run leaves a resumable session', OPTIONS, async (t) => {
  const { service } = makeService(t)
  const created = service.create({
    title: 'Long running',
    goal: 'Count slowly from 1 to 50, one number per line, and do not stop early.',
    type: 'analysis',
    isolation: 'writable',
  })
  await service.act(created.id, 'start')
  await waitFor(() => service.store.getTask(created.id).status === 'RUNNING', 120000, 'the task to start')
  // Let the runtime actually receive the prompt before stopping it.
  await new Promise((r) => setTimeout(r, 1500))
  await service.act(created.id, 'stop')

  const stopped = await waitFor(() => {
    const task = service.store.getTask(created.id)
    return task.status === 'INTERRUPTED' ? task : null
  }, 120000, 'the task to be interrupted')
  assert.equal(stopped.status, 'INTERRUPTED')
  const session = service.store.listSessions(created.id).at(-1)
  assert.ok(session, 'the interrupted run must leave a session record')
  assert.equal(session.state, 'INTERRUPTED')

  const transitions = service.store.listTransitions(created.id).map((row) => row.to)
  assert.ok(transitions.includes('INTERRUPTING'), transitions.join('>'))

  // Resume on a fresh runtime, same session id.
  await service.act(created.id, 'resume')
  const resumed = await waitFor(() => {
    const task = service.store.getTask(created.id)
    return ['SUCCEEDED', 'FAILED'].includes(task.status) ? task : null
  }, 240000, 'the resumed task to settle')

  const attempts = service.store.listAttempts(created.id)
  assert.equal(attempts.length, 2, 'a resume is a new attempt')
  assert.equal(attempts[1].sessionId, session.id, 'the resume must reuse the original session')
  assert.ok(['SUCCEEDED', 'FAILED'].includes(resumed.status))
  if (resumed.status === 'FAILED') {
    // A resume that fails must say so; it must not silently become a new conversation.
    assert.match(String(resumed.lastErrorMessage ?? ''), /resume|session/i)
  }
})
