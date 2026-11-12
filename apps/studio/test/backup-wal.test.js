/**
 * The pre-restore safety copy under WAL, and the verification that follows a restore.
 *
 * The bug: the safety copy was fs.copyFileSync of the main .db file. Under WAL, committed
 * transactions live in the -wal until a checkpoint, so the copy could be missing the most
 * recent writes — the exact data a user would need if the restore went wrong.
 *
 * These deliberately do NOT close the database or checkpoint first: doing so would hide the
 * problem the test exists to catch.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { createBackup, restoreBackup, verifyDatabase } = require('../dist/main/projects/backup.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-wal-'))
  const dbPath = path.join(dir, 'studio.db')
  const store = new TaskStore(dbPath)
  t.after(() => { try { store.close() } catch {} })
  const projects = new ProjectStore(store)
  return { dir, dbPath, store, projects }
}

test('the safety copy contains writes that are still only in the WAL', (t) => {
  const { dir, dbPath, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'Before', rootPath: path.join(dir, 'r1'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

  // A write that has not been checkpointed. WAL mode keeps it in the -wal file.
  projects.create({ id: 'proj-2', name: 'OnlyInWal', rootPath: path.join(dir, 'r2'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  assert.equal(fs.existsSync(dbPath + '-wal'), true, 'the test needs a live WAL to be meaningful')

  const safety = path.join(dir, 'safety.db')
  const result = restoreBackup(dbPath, path.join(dir, 'missing.db'), safety)
  assert.equal(result.ok, false, 'a missing backup must fail')
  assert.ok(result.safetyCopy, 'a safety copy must still have been taken')

  // Read the safety copy on its own: it must contain the row that was only in the WAL.
  const copy = new DatabaseSync(safety, { readOnly: true })
  try {
    const row = copy.prepare("SELECT name FROM projects WHERE id = 'proj-2'").get()
    assert.equal(row?.name, 'OnlyInWal', 'the safety copy must include uncheckpointed writes')
  } finally {
    copy.close()
  }
})

test('the safety copy is a valid database, not a byte copy of the main file', (t) => {
  const { dir, dbPath, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'P', rootPath: path.join(dir, 'r1'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

  const safety = path.join(dir, 'safety.db')
  restoreBackup(dbPath, path.join(dir, 'missing.db'), safety)

  const report = verifyDatabase(safety, ['schema_version', 'tasks', 'projects'], 2)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.integrity, 'ok')
  assert.equal(report.foreignKeyViolations, 0)
})

test('a failed restore leaves the safety copy usable for a later restore', (t) => {
  const { dir, dbPath, projects } = setup(t)
  projects.create({ id: 'proj-1', name: 'Recoverable', rootPath: path.join(dir, 'r1'), engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

  const safety = path.join(dir, 'safety.db')
  const failed = restoreBackup(dbPath, path.join(dir, 'nope.db'), safety)
  assert.equal(failed.ok, false)

  // Use the safety copy as the source of a second restore: it must work.
  const second = restoreBackup(dbPath, safety, path.join(dir, 'safety2.db'))
  assert.equal(second.ok, true, second.error)
  const after = new ProjectStore({ db: new TaskStore(dbPath).db })
  assert.equal(after.get('proj-1').name, 'Recoverable')
})

test('verification rejects a database that is missing a required table', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-verify-'))
  const dbPath = path.join(dir, 'partial.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (2);')
  db.close()

  const report = verifyDatabase(dbPath, ['schema_version', 'tasks', 'projects'], 2)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missingTables.sort(), ['projects', 'tasks'])
})

test('verification rejects a database whose schema version is too new', (t) => {
  const { dir, dbPath } = setup(t)
  const report = verifyDatabase(dbPath, ['schema_version', 'tasks', 'projects'], 1)
  assert.equal(report.ok, false, 'a version above what this build supports must be refused')
  assert.equal(report.schemaVersion, 2)
})

test('verification rejects a file that is not a database', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-verify2-'))
  const file = path.join(dir, 'x.db')
  fs.writeFileSync(file, 'not a database')
  const report = verifyDatabase(file, ['schema_version'], 2)
  assert.equal(report.ok, false)
  assert.ok(report.error)
})

test('verification catches a broken foreign key', (t) => {
  const { dir, dbPath, store } = setup(t)
  // Insert a task pointing at a project that does not exist, with FK enforcement off so the
  // row lands; the check must then find it.
  store.db.exec('PRAGMA foreign_keys = OFF;')
  store.db
    .prepare("INSERT INTO tasks (id,title,goal,type,isolation,status,created_at,updated_at,acceptance,project_id) VALUES ('t1','t','g','a','readonly','CREATED','2026-01-01','2026-01-01','{}','ghost')")
    .run()
  store.db.exec('PRAGMA foreign_keys = ON;')

  const report = verifyDatabase(dbPath, ['schema_version', 'tasks', 'projects'], 2)
  assert.equal(report.ok, false, 'a dangling project_id must fail verification')
  assert.ok(report.foreignKeyViolations > 0, 'foreign_key_check must report it')
})
