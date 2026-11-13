/**
 * Backup and restore through ProjectService, with the database connection live.
 *
 * The function-level tests close the store first, which is not what the app does. These
 * exercise the online path: the service closes the connection, replaces the file, reopens
 * it, and verifies by reading back through the normal store.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { ProjectService } = require('../dist/main/projects/service.js')

const ACCEPTANCE = { requireCompletedRun: true, requireResponse: true, requiredTools: [] }

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bkapp-'))
  const dbPath = path.join(dir, 'studio.db')
  let store = new TaskStore(dbPath)
  t.after(() => { try { store.close() } catch {} })

  // One owner for the connection. The service closes it before a restore and reopens it
  // after; the test reads through whatever is current, never through a stale handle.
  const service = new ProjectService({
    db: store.db,
    logger: { info() {}, warn() {}, error() {} },
    dataDir: path.join(dir, 'project-data'),
    dbPath,
    closeDatabase: () => {
      store.close()
    },
    reopenDatabase: () => {
      const reopened = new TaskStore(dbPath)
      store = reopened
      return {
        db: reopened.db,
        verify: () => {
          try {
            return new ProjectStore({ db: reopened.db }).list().length >= 0 && reopened.schemaVersion >= 1
          } catch {
            return false
          }
        },
      }
    },
    hasActiveWork: options.hasActiveWork ?? (() => false),
  })

  const root = fs.mkdtempSync(path.join(dir, 'game-'))
  const project = service.create({ name: 'P', rootPath: root, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  return { dir, dbPath, service, project, getStore: () => store }
}

test('a backup is written to a stable, recognisable location', (t) => {
  const { service, project } = setup(t)
  const result = service.createBackup(project.id)
  assert.equal(result.ok, true, result.error)
  assert.ok(result.file.endsWith('.db'))
  assert.ok(result.file.includes(project.id), 'the backup should be filed under the project')
  assert.ok(fs.existsSync(result.file))
  assert.ok(result.bytes > 0)

  const listed = service.listBackups(project.id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].file, result.file)
})

test('a backup can be reopened as a database', (t) => {
  const { service, project } = setup(t)
  const result = service.createBackup(project.id)
  const { readTables } = require('../dist/main/projects/backup.js')
  const tables = readTables(result.file)
  for (const name of ['projects', 'tasks', 'schema_version']) {
    assert.ok(tables.includes(name), 'backup missing ' + name)
  }
})

test('restoring brings back a project deleted after the backup, with the connection live', (t) => {
  const { service, project, getStore } = setup(t)
  const backup = service.createBackup(project.id)
  assert.equal(backup.ok, true, backup.error)

  getStore().db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)
  assert.equal(service.store.get(project.id), null)

  const restored = service.restoreBackup(project.id, backup.file)
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.verified, true)
  assert.ok(restored.safetyCopy, 'a safety copy must be taken before replacing the database')

  // Read back through the reopened store, not the backup file.
  const after = new ProjectStore({ db: getStore().db })
  assert.equal(after.get(project.id).name, 'P')
})

test('a restore keeps task and session links', (t) => {
  const { service, project, getStore } = setup(t)
  const store = getStore()
  store.createTask({ id: 'task-1', title: 't', goal: 'g', type: 'analysis', isolation: 'readonly', acceptance: ACCEPTANCE, projectId: project.id })
  store.createAttempt({ id: 'att-1', taskId: 'task-1', attemptNo: 1, sessionId: 'sess-1' })
  store.upsertSession({ id: 'sess-1', taskId: 'task-1', attemptId: 'att-1', state: 'ACTIVE' })

  const backup = service.createBackup(project.id)
  store.db.prepare('DELETE FROM sessions').run()
  store.db.prepare('DELETE FROM attempts').run()

  const restored = service.restoreBackup(project.id, backup.file)
  assert.equal(restored.ok, true, restored.error)

  const view = getStore().getTaskView('task-1')
  assert.equal(view.attempts.length, 1)
  assert.equal(view.sessions.length, 1)
  assert.equal(view.sessions[0].id, 'sess-1')
  assert.equal(view.projectId, project.id)
})

test('a corrupt backup is refused and the live database keeps working', (t) => {
  const { service, project, dir, getStore } = setup(t)
  const bogus = path.join(dir, 'bogus.db')
  fs.writeFileSync(bogus, 'not a database')

  const result = service.restoreBackup(project.id, bogus)
  assert.equal(result.ok, false)
  assert.ok(result.error)
  assert.equal(service.store.get(project.id).name, 'P', 'the live database must be untouched')
  assert.equal(getStore().schemaVersion, 4, 'the connection must still be usable')
})

test('a restore is refused while work is in flight', (t) => {
  const { service, project } = setup(t, { hasActiveWork: () => true })
  const backup = service.createBackup(project.id)
  const result = service.restoreBackup(project.id, backup.file)
  assert.equal(result.ok, false)
  assert.match(String(result.error), /任务正在执行/)
})

test('a missing backup file is reported', (t) => {
  const { service, project, dir } = setup(t)
  const result = service.restoreBackup(project.id, path.join(dir, 'nope.db'))
  assert.equal(result.ok, false)
  assert.match(String(result.error), /不存在/)
})
