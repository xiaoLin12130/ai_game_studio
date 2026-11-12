/**
 * Project lifecycle against a real database and real directories.
 *
 * The rule that matters most here: creating a project must never write into a directory
 * that already holds something. Losing a user's files to a "new project" is unrecoverable.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectService, ProjectError, validateProjectName } = require('../dist/main/projects/service.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-svc-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const events = []
  const logger = {
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
  }
  const service = new ProjectService({ db: store.db, logger, dataDir: path.join(dir, 'project-data') })
  const emptyRoot = () => {
    const p = fs.mkdtempSync(path.join(dir, 'root-'))
    return p
  }
  return { dir, store, service, events, emptyRoot }
}

const input = (rootPath, overrides = {}) => ({
  name: 'My Game',
  rootPath,
  engine: 'cocos-creator-3.8.6',
  platform: 'wechat-minigame',
  ...overrides,
})

test('a project is created in an empty directory and marked on disk', (t) => {
  const { service, emptyRoot } = setup(t)
  const root = emptyRoot()
  const project = service.create(input(root))
  assert.equal(project.name, 'My Game')
  assert.equal(project.engine, 'cocos-creator-3.8.6')
  assert.equal(project.platform, 'wechat-minigame')
  assert.equal(fs.existsSync(path.join(root, '.studio-project.json')), true, 'the directory should be recognisable')
})

test('a non-empty directory is refused, and nothing is written into it', (t) => {
  const { service, emptyRoot } = setup(t)
  const root = emptyRoot()
  fs.writeFileSync(path.join(root, 'important.txt'), 'user data')

  assert.throws(() => service.create(input(root)), (error) => {
    assert.equal(error instanceof ProjectError, true)
    assert.equal(error.code, 'ROOT_NOT_EMPTY')
    return true
  })
  assert.equal(fs.readFileSync(path.join(root, 'important.txt'), 'utf8'), 'user data', 'existing files must be untouched')
  assert.equal(fs.existsSync(path.join(root, '.studio-project.json')), false, 'a refused create must not leave a marker')
  assert.equal(service.list().length, 0)
})

test('the same directory cannot become two projects', (t) => {
  const { service, emptyRoot } = setup(t)
  const root = emptyRoot()
  service.create(input(root))
  assert.throws(() => service.create(input(root, { name: 'Second' })), (error) => {
    assert.equal(error.code, 'ROOT_ALREADY_USED')
    return true
  })
})

test('an invalid name is refused with a readable reason', (t) => {
  const { service, emptyRoot } = setup(t)
  const root = emptyRoot()
  assert.throws(() => service.create(input(root, { name: '   ' })), /INVALID_NAME/)
  assert.throws(() => service.create(input(root, { name: 'a/b' })), /INVALID_NAME/)
  assert.throws(() => service.create(input(root, { name: 'x'.repeat(61) })), /INVALID_NAME/)
  assert.equal(validateProjectName('我的游戏').ok, true)
})

test('an unsupported engine or platform is refused rather than silently accepted', (t) => {
  const { service, emptyRoot } = setup(t)
  assert.throws(() => service.create(input(emptyRoot(), { engine: 'unity-2022' })), /UNSUPPORTED_ENGINE/)
  assert.throws(() => service.create(input(emptyRoot(), { platform: 'android' })), /UNSUPPORTED_PLATFORM/)
})

test('a missing or unwritable directory is refused', (t) => {
  const { service, dir } = setup(t)
  assert.throws(() => service.create(input(path.join(dir, 'does-not-exist'))), /ROOT_UNUSABLE/)
  assert.throws(() => service.create(input('relative/path')), /ROOT_UNUSABLE/)
})

test('open and close are recorded, and the project survives a restart', (t) => {
  const { service, store, emptyRoot, dir } = setup(t)
  const root = emptyRoot()
  const project = service.create(input(root))

  service.open(project.id)
  assert.equal(service.openProject, project.id)
  service.close(project.id)
  assert.equal(service.openProject, null)

  const view = service.view(project.id)
  assert.ok(view.lastOpenedAt, 'opening must be recorded')
  assert.deepEqual(view.events.map((e) => e.kind).sort(), ['project.closed', 'project.created', 'project.opened'])

  // Reopen the database the way a restart would.
  store.close()
  const reopened = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => reopened.close())
  const again = new ProjectService({ db: reopened.db, logger: { info() {}, warn() {}, error() {} }, dataDir: path.join(dir, 'project-data') })
  assert.equal(again.list().length, 1)
  assert.equal(again.list()[0].id, project.id)
})

test('opening a project whose directory disappeared fails with a reason', (t) => {
  const { service, emptyRoot } = setup(t)
  const root = emptyRoot()
  const project = service.create(input(root))
  fs.rmSync(root, { recursive: true, force: true })
  assert.throws(() => service.open(project.id), (error) => {
    assert.equal(error.code, 'ROOT_UNUSABLE')
    return true
  })
})

test('config is saved and read back', (t) => {
  const { service, emptyRoot } = setup(t)
  const project = service.create(input(emptyRoot()))
  service.updateConfig(project.id, { designWidth: 1280, orientation: 'portrait' })
  assert.deepEqual(service.view(project.id).config.settings, { designWidth: 1280, orientation: 'portrait' })
})

test('two projects keep separate configs and event streams', (t) => {
  const { service, emptyRoot } = setup(t)
  const a = service.create(input(emptyRoot(), { name: 'A' }))
  const b = service.create(input(emptyRoot(), { name: 'B' }))
  service.updateConfig(a.id, { only: 'a' })

  assert.deepEqual(service.view(a.id).config.settings, { only: 'a' })
  assert.deepEqual(service.view(b.id).config.settings, {})
  assert.equal(service.view(a.id).events.some((e) => e.kind === 'project.config.updated'), true)
  assert.equal(service.view(b.id).events.some((e) => e.kind === 'project.config.updated'), false)
})
