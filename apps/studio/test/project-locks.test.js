/**
 * Project write lock and build lock.
 *
 * The failure these tests guard against: a lock that outlives its owner. If "the row exists"
 * meant "the project is busy", a crashed run would lock a project forever, so staleness is
 * decided by whether the owner process is still alive, not by the row's presence.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { ProjectLocks, LockError } = require('../dist/main/projects/locks.js')

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-locks-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const projects = new ProjectStore(store)
  projects.create({ id: 'proj-1', name: 'P', rootPath: path.join(dir, 'root'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  const locks = new ProjectLocks(store.db, options)
  return { store, projects, locks }
}

test('one writer at a time', (t) => {
  const { locks } = setup(t)
  locks.acquireWrite('proj-1', 'task-a')
  assert.throws(() => locks.acquireWrite('proj-1', 'task-b'), (error) => {
    assert.equal(error instanceof LockError, true)
    assert.equal(error.code, 'HELD_BY_OTHER')
    assert.equal(error.holder.ownerId, 'task-a')
    return true
  })
})

test('the same owner can re-acquire without deadlocking itself', (t) => {
  const { locks } = setup(t)
  locks.acquireWrite('proj-1', 'task-a')
  const again = locks.acquireWrite('proj-1', 'task-a')
  assert.equal(again.ownerId, 'task-a')
})

test('releasing lets the next writer in', (t) => {
  const { locks } = setup(t)
  locks.acquireWrite('proj-1', 'task-a')
  locks.release('proj-1', 'write', 'task-a')
  const next = locks.acquireWrite('proj-1', 'task-b')
  assert.equal(next.ownerId, 'task-b')
})

test('only the owner may release', (t) => {
  const { locks } = setup(t)
  locks.acquireWrite('proj-1', 'task-a')
  assert.throws(() => locks.release('proj-1', 'write', 'task-b'), /NOT_OWNER/)
  assert.equal(locks.current('proj-1').write.ownerId, 'task-a', 'a failed release must not free the lock')
})

test('a build excludes writers and a writer excludes builds', (t) => {
  const { locks } = setup(t)
  locks.acquireBuild('proj-1', 'build-1')
  assert.throws(() => locks.acquireWrite('proj-1', 'task-a'), (error) => {
    assert.equal(error.code, 'BUILD_IN_PROGRESS')
    return true
  })
  locks.release('proj-1', 'build', 'build-1')

  locks.acquireWrite('proj-1', 'task-a')
  assert.throws(() => locks.acquireBuild('proj-1', 'build-2'), (error) => {
    assert.equal(error.code, 'WRITER_ACTIVE')
    return true
  })
})

test('two builds cannot overlap', (t) => {
  const { locks } = setup(t)
  locks.acquireBuild('proj-1', 'build-1')
  assert.throws(() => locks.acquireBuild('proj-1', 'build-2'), /HELD_BY_OTHER/)
})

test('a lock whose owner process is gone is reclaimable', (t) => {
  const { locks } = setup(t, { isProcessAlive: () => false })
  locks.acquireWrite('proj-1', 'crashed-task', 999999)
  assert.equal(locks.isStale(locks.current('proj-1').write), true)
  const taken = locks.acquireWrite('proj-1', 'task-b')
  assert.equal(taken.ownerId, 'task-b', 'a dead owner must not block the project forever')
})

test('a live owner is not reclaimed just because time passed', (t) => {
  const { locks } = setup(t, { isProcessAlive: () => true, staleAfterMs: 1000, now: () => Date.now() })
  locks.acquireWrite('proj-1', 'task-a')
  assert.equal(locks.isStale(locks.current('proj-1').write), false)
  assert.throws(() => locks.acquireWrite('proj-1', 'task-b'), /HELD_BY_OTHER/)
})

test('a lock that stopped heartbeating is reclaimable even if the pid is alive', (t) => {
  let clock = Date.now()
  const { locks } = setup(t, { isProcessAlive: () => true, staleAfterMs: 1000, now: () => clock })
  locks.acquireWrite('proj-1', 'task-a')
  clock += 5000
  assert.equal(locks.isStale(locks.current('proj-1').write), true)
})

test('heartbeat keeps a long operation from looking abandoned', (t) => {
  let clock = Date.now()
  const { locks } = setup(t, { isProcessAlive: () => true, staleAfterMs: 1000, now: () => clock })
  locks.acquireWrite('proj-1', 'task-a')
  clock += 800
  locks.heartbeat('proj-1', 'write', 'task-a')
  clock += 800
  assert.equal(locks.isStale(locks.current('proj-1').write), false)
})

test('a non-owner cannot heartbeat', (t) => {
  const { locks } = setup(t)
  locks.acquireWrite('proj-1', 'task-a')
  assert.throws(() => locks.heartbeat('proj-1', 'write', 'task-b'), /NOT_OWNER/)
})

test('shutdown releases everything a process held', (t) => {
  const { locks } = setup(t)
  locks.acquireWrite('proj-1', 'task-a', 4242)
  assert.equal(locks.releaseAllFor(4242), 1)
  assert.equal(locks.current('proj-1').write, null)
})

test('locks on different projects do not interfere', (t) => {
  const { store, projects, locks } = setup(t)
  projects.create({ id: 'proj-2', name: 'Q', rootPath: path.join(os.tmpdir(), 'other-root-' + Date.now()), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  locks.acquireWrite('proj-1', 'task-a')
  const other = locks.acquireWrite('proj-2', 'task-b')
  assert.equal(other.projectId, 'proj-2')
})
