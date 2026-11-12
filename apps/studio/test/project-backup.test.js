/**
 * Backup and restore, verified by actually restoring.
 *
 * "The file was created" is not a backup test. These restore into a live database and then
 * read the data back through the normal store, which is the only check that proves the
 * backup contains what the app needs.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { createBackup, restoreBackup, readTables } = require('../dist/main/projects/backup.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-backup-'))
  const dbPath = path.join(dir, 'studio.db')
  const store = new TaskStore(dbPath)
  t.after(() => { try { store.close() } catch {} })
  const projects = new ProjectStore(store)
  return { dir, dbPath, store, projects }
}

const ACCEPTANCE = { requireCompletedRun: true, requireResponse: true, requiredTools: [] }

test('a backup is a readable database with the expected tables', (t) => {
  const { dir, dbPath, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'P', rootPath: path.join(dir, 'root'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

  const backup = createBackup(dbPath, path.join(dir, 'backups', 'one.db'))
  assert.equal(backup.ok, true, backup.error)
  assert.ok(backup.bytes > 0)
  for (const name of ['schema_version', 'tasks', 'projects']) {
    assert.ok(backup.tables.includes(name), 'backup missing ' + name)
  }
})

test('restoring brings back a project that was deleted after the backup', (t) => {
  const { dir, dbPath, store, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'Keep me', rootPath: path.join(dir, 'root'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  const backupPath = path.join(dir, 'backups', 'one.db')
  assert.equal(createBackup(dbPath, backupPath).ok, true)

  // Lose it the way a bad migration or a user mistake would.
  store.db.prepare('DELETE FROM projects WHERE id = ?').run('proj-1')
  assert.equal(projects.get('proj-1'), null)
  store.close()

  const restored = restoreBackup(dbPath, backupPath, path.join(dir, 'backups', 'safety.db'))
  assert.equal(restored.ok, true, restored.error)
  assert.ok(restored.safetyCopy, 'a safety copy must be taken before overwriting')

  const reopened = new TaskStore(dbPath)
  t.after(() => reopened.close())
  const after = new ProjectStore(reopened)
  assert.equal(after.get('proj-1').name, 'Keep me')
})

test('a restore keeps the task and session links intact', (t) => {
  const { dir, dbPath, store, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'P', rootPath: path.join(dir, 'root'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  store.createTask({ id: 'task-1', title: 't', goal: 'g', type: 'analysis', isolation: 'readonly', acceptance: ACCEPTANCE })
  store.db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run('proj-1', 'task-1')
  store.createAttempt({ id: 'att-1', taskId: 'task-1', attemptNo: 1, sessionId: 'sess-1' })
  store.upsertSession({ id: 'sess-1', taskId: 'task-1', attemptId: 'att-1', state: 'ACTIVE' })

  const backupPath = path.join(dir, 'backups', 'linked.db')
  assert.equal(createBackup(dbPath, backupPath).ok, true)
  store.close()

  assert.equal(restoreBackup(dbPath, backupPath, path.join(dir, 'backups', 'safety.db')).ok, true)
  const reopened = new TaskStore(dbPath)
  t.after(() => reopened.close())
  const view = reopened.getTaskView('task-1')
  assert.equal(view.attempts.length, 1)
  assert.equal(view.sessions.length, 1)
  assert.equal(view.sessions[0].id, 'sess-1')
  assert.equal(new ProjectStore(reopened).countTasks('proj-1'), 1, 'the project link must survive')
})

test('a corrupt backup is refused instead of overwriting the live database', (t) => {
  const { dir, dbPath, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'P', rootPath: path.join(dir, 'root'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

  const bogus = path.join(dir, 'backups', 'bogus.db')
  fs.mkdirSync(path.dirname(bogus), { recursive: true })
  fs.writeFileSync(bogus, 'this is not a database')

  const result = restoreBackup(dbPath, bogus, path.join(dir, 'backups', 'safety.db'))
  assert.equal(result.ok, false)
  assert.ok(result.error)
  assert.equal(projects.get('proj-1').name, 'P', 'the live database must be untouched')
})

test('a missing backup file is reported, not silently ignored', (t) => {
  const { dir, dbPath } = setup(t)
  const result = restoreBackup(dbPath, path.join(dir, 'nope.db'), path.join(dir, 'safety.db'))
  assert.equal(result.ok, false)
  assert.match(String(result.error), /does not exist/)
})

test('readTables rejects a file that is not a database', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-notdb-'))
  const file = path.join(dir, 'x.db')
  fs.writeFileSync(file, 'nope')
  assert.throws(() => readTables(file))
})
