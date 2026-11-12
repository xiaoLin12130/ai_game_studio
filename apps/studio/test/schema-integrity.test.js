/**
 * The required-table list, and what happens when a backup is missing one of them.
 *
 * The list is taken from the CREATE TABLE statements in the migrations, not written by hand:
 * a restore that never noticed a missing table would produce a database that is half backup
 * and half current data while reporting success.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')
const { ProjectService } = require('../dist/main/projects/service.js')
const {
  REQUIRED_TABLES,
  SCHEMA_VERSION_MAX,
  createBackup,
  restoreBackup,
  verifyDatabase,
} = require('../dist/main/projects/backup.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-schema-'))
  const dbPath = path.join(dir, 'studio.db')
  const store = new TaskStore(dbPath)
  t.after(() => { try { store.close() } catch {} })
  const projects = new ProjectStore(store)
  const service = new ProjectService({
    db: store.db,
    logger: { info() {}, warn() {}, error() {} },
    dataDir: path.join(dir, 'project-data'),
    dbPath,
    reopenDatabase: () => ({ db: store.db, verify: () => service.verifyLiveDatabase().ok }),
  })
  const root = fs.mkdtempSync(path.join(dir, 'game-'))
  const project = service.create({ name: 'P', rootPath: root, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  return { dir, dbPath, store, projects, service, project }
}

/** Copy the live database, then drop one table from the copy. */
function backupWithout(stagingDir, dbPath, table) {
  const target = path.join(stagingDir, 'partial-' + table + '.db')
  const result = createBackup(dbPath, target)
  assert.equal(result.ok, true, result.error)
  const db = new DatabaseSync(target)
  db.exec('DROP TABLE "' + table + '";')
  db.close()
  return target
}

test('the required list matches the migrations exactly', (t) => {
  const { dir, dbPath } = setup(t)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
  db.close()

  assert.deepEqual([...REQUIRED_TABLES].sort(), actual.sort(), 'the list must not drift from the schema')
  assert.equal(REQUIRED_TABLES.length, 24)
})

test('a complete v2 database passes verification', (t) => {
  const { dbPath } = setup(t)
  const report = verifyDatabase(dbPath, REQUIRED_TABLES, SCHEMA_VERSION_MAX)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.integrity, 'ok')
  assert.equal(report.foreignKeyViolations, 0)
  assert.equal(report.schemaVersion, 3)
  assert.deepEqual(report.missingTables, [])
})

for (const table of ['project_configs', 'project_events', 'approvals', 'project_locks', 'task_transitions', 'runtimes', 'verifications', 'events', 'advisor_conversations', 'advisor_messages', 'drafts', 'draft_versions', 'requirement_baselines', 'change_proposals', 'attachments', 'research_reports']) {
  test('verification fails when ' + table + ' is missing', (t) => {
    const { dir, dbPath } = setup(t)
    const staging = fs.mkdtempSync(path.join(dir, 'staging-'))
    const partial = backupWithout(staging, dbPath, table)

    const report = verifyDatabase(partial, REQUIRED_TABLES, SCHEMA_VERSION_MAX)
    assert.equal(report.ok, false, 'a database without ' + table + ' must not verify')
    assert.ok(report.missingTables.includes(table), 'the report must name ' + table)
  })
}

test('verification fails when a task link table is missing', (t) => {
  const { dir, dbPath } = setup(t)
  const staging = fs.mkdtempSync(path.join(dir, 'staging-'))
  const partial = backupWithout(staging, dbPath, 'attempts')
  const report = verifyDatabase(partial, REQUIRED_TABLES, SCHEMA_VERSION_MAX)
  assert.equal(report.ok, false)
  assert.ok(report.missingTables.includes('attempts'))
})

test('verification fails on an older schema version', (t) => {
  const { dbPath } = setup(t)
  // The database is at v3; demanding v4 as the minimum is what "too old" means.
  const report = verifyDatabase(dbPath, REQUIRED_TABLES, SCHEMA_VERSION_MAX, 4)
  assert.equal(report.ok, false, 'a version below the minimum must be refused')
})

test('verification fails on a newer schema version', (t) => {
  const { dbPath } = setup(t)
  const report = verifyDatabase(dbPath, REQUIRED_TABLES, 1)
  assert.equal(report.ok, false, 'a version above what this build supports must be refused')
})

test('restoring an incomplete backup is refused and reports what is missing', (t) => {
  const { service, project, dir, dbPath } = setup(t)
  const staging = fs.mkdtempSync(path.join(dir, 'staging-'))
  const partial = backupWithout(staging, dbPath, 'approvals')

  const result = service.restoreBackup(project.id, partial)
  assert.equal(result.ok, false, 'an incomplete backup must not be reported as a successful restore')
  assert.match(String(result.error), /approvals/)
  assert.equal(result.safetyCopy, null, 'a refused pre-flight check needs no safety copy')
})

test('a refused restore leaves the live database and its rows intact', (t) => {
  const { service, project, dir, dbPath, store } = setup(t)
  const staging = fs.mkdtempSync(path.join(dir, 'staging-'))
  const partial = backupWithout(staging, dbPath, 'project_locks')

  store.createTask({ id: 'keep-me', title: 't', goal: 'g', type: 'analysis', isolation: 'readonly', acceptance: { requireCompletedRun: true, requireResponse: true, requiredTools: [] } })
  const before = store.getTask('keep-me')
  assert.ok(before)

  const result = service.restoreBackup(project.id, partial)
  assert.equal(result.ok, false)
  assert.equal(store.getTask('keep-me').id, 'keep-me', 'a refused restore must not touch existing rows')
  assert.equal(service.verifyLiveDatabase().ok, true, 'the live database must still verify')
})

test('a failed restore leaves a safety copy that can be used', (t) => {
  const { service, project, dir, dbPath } = setup(t)
  const staging = fs.mkdtempSync(path.join(dir, 'staging-'))

  // A backup that passes the pre-flight table check but cannot be restored: valid tables,
  // then a required table emptied of a column the insert needs.
  const snapshot = path.join(staging, 'good.db')
  assert.equal(createBackup(dbPath, snapshot).ok, true)
  const db = new DatabaseSync(snapshot)
  db.exec('ALTER TABLE projects RENAME TO projects_renamed; CREATE TABLE projects (id TEXT PRIMARY KEY);')
  db.close()

  const result = service.restoreBackup(project.id, snapshot)
  assert.equal(result.ok, false, 'a structurally wrong backup must not restore')
  assert.ok(result.safetyCopy, 'a restore that got past pre-flight must leave a safety copy')

  const copy = new DatabaseSync(result.safetyCopy, { readOnly: true })
  try {
    const row = copy.prepare("SELECT name FROM projects WHERE id = ?").get(project.id)
    assert.equal(row?.name, 'P', 'the safety copy must hold the data that was live')
  } finally {
    copy.close()
  }
})
