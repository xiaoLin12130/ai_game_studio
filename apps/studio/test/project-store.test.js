/**
 * Project persistence and the v2 migration.
 *
 * These use a real SQLite file, and the migration test starts from a database that only has
 * the v1 task tables — the situation an existing user is actually in.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { TaskStore, SCHEMA_VERSION } = require('../dist/main/tasks/store.js')
const { ProjectStore } = require('../dist/main/projects/store.js')

function fresh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-proj-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  return { dir, store, projects: new ProjectStore(store) }
}

const input = (overrides = {}) => ({
  id: 'proj-1',
  name: 'My Game',
  rootPath: path.join(os.tmpdir(), 'game-root-1'),
  engine: 'cocos-creator-3.8.6',
  platform: 'wechat-minigame',
  ...overrides,
})

test('the schema is at the current version and has the project tables', (t) => {
  const { store } = fresh(t)
  assert.equal(store.schemaVersion, SCHEMA_VERSION)
  assert.equal(SCHEMA_VERSION, 4)
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  for (const name of ['projects', 'project_configs', 'project_events', 'approvals', 'project_locks']) {
    assert.ok(tables.includes(name), 'missing table: ' + name)
  }
})

test('a project round-trips with its config and events', (t) => {
  const { projects } = fresh(t)
  const created = projects.create(input())
  assert.equal(created.name, 'My Game')
  assert.equal(created.status, 'ACTIVE')
  assert.equal(created.lastOpenedAt, null)

  projects.updateConfig('proj-1', { theme: 'dark' })
  projects.touchOpened('proj-1')
  const view = projects.view('proj-1')
  assert.deepEqual(view.config.settings, { theme: 'dark' })
  assert.ok(view.lastOpenedAt, 'opening must be recorded')
  assert.deepEqual(view.events.map((e) => e.kind).sort(), ['project.config.updated', 'project.created', 'project.opened'])
})

test('two projects cannot share a root', (t) => {
  const { projects } = fresh(t)
  projects.create(input())
  assert.throws(() => projects.create(input({ id: 'proj-2', name: 'Other' })), /UNIQUE|constraint/i)
})

test('tasks can belong to a project, and closing a project keeps them', (t) => {
  const { store, projects } = fresh(t)
  projects.create(input())
  store.createTask({ id: 'task-1', title: 't', goal: 'g', type: 'analysis', isolation: 'readonly', acceptance: { requireCompletedRun: true, requireResponse: true, requiredTools: [] } })
  store.db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run('proj-1', 'task-1')
  assert.equal(projects.countTasks('proj-1'), 1)

  projects.recordClosed('proj-1')
  assert.equal(projects.countTasks('proj-1'), 1, 'closing a project must not delete its tasks')
  assert.equal(store.getTask('task-1').id, 'task-1')
})

test('approvals exist as a shape with a status', (t) => {
  const { projects } = fresh(t)
  projects.create(input())
  const approval = projects.createApproval({ id: 'ap-1', projectId: 'proj-1', subject: 'freeze the requirements' })
  assert.equal(approval.status, 'PENDING')
  assert.equal(approval.decidedAt, null)
  assert.equal(projects.listApprovals('proj-1').length, 1)
})

test('a v1 database migrates to the current version and keeps its tasks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migrate-'))
  const dbPath = path.join(dir, 'studio.db')

  // Build a v1 database by hand: the task tables only, schema_version = 1.
  const v1 = new DatabaseSync(dbPath)
  v1.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (1);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, type TEXT NOT NULL,
      isolation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      current_attempt_id TEXT, acceptance TEXT NOT NULL, last_error_code TEXT, last_error_message TEXT
    );
    INSERT INTO tasks VALUES ('old-task','old','goal','analysis','readonly','CREATED','2026-01-01','2026-01-01',NULL,'{}',NULL,NULL);
  `)
  v1.close()

  const upgraded = new TaskStore(dbPath)
  t.after(() => upgraded.close())
  assert.equal(upgraded.schemaVersion, 4)
  assert.equal(upgraded.getTask('old-task').title, 'old', 'existing rows must survive the migration')
  const columns = upgraded.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name)
  assert.ok(columns.includes('project_id'), 'the new column must be added')
})

test('a failed migration leaves the database at its previous version', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migfail-'))
  const dbPath = path.join(dir, 'studio.db')

  // A v1 database that already has a "projects" table of a different shape: the v2
  // migration will fail partway, which is exactly the case that must not corrupt v1 data.
  const v1 = new DatabaseSync(dbPath)
  v1.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (1);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, type TEXT NOT NULL,
      isolation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      current_attempt_id TEXT, acceptance TEXT NOT NULL, last_error_code TEXT, last_error_message TEXT
    );
    INSERT INTO tasks VALUES ('keep-me','keep','goal','analysis','readonly','CREATED','2026-01-01','2026-01-01',NULL,'{}',NULL,NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
  `)
  v1.close()

  assert.throws(() => new TaskStore(dbPath), /.*/)

  const after = new DatabaseSync(dbPath)
  t.after(() => after.close())
  const version = after.prepare('SELECT version FROM schema_version').get().version
  assert.equal(version, 1, 'a failed migration must not advance the version')
  const row = after.prepare("SELECT title FROM tasks WHERE id = 'keep-me'").get()
  assert.equal(row.title, 'keep', 'a failed migration must not lose existing rows')
})
