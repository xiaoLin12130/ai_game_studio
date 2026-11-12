/**
 * ProjectService.resolveProjectPath is the single entry point for project-scoped file
 * access, so these tests call it directly rather than testing assertInsideProject in
 * isolation. A containment check that the service does not use protects nothing.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { TaskStore } = require('../dist/main/tasks/store.js')
const { ProjectService } = require('../dist/main/projects/service.js')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-resolve-'))
  const store = new TaskStore(path.join(dir, 'studio.db'))
  t.after(() => store.close())
  const service = new ProjectService({ db: store.db, logger: { info() {}, warn() {}, error() {} }, dataDir: path.join(dir, 'data') })
  const root = fs.mkdtempSync(path.join(dir, 'game-'))
  const project = service.create({ name: 'P', rootPath: root, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
  return { dir, service, project, root }
}

test('a normal relative path resolves inside the project', (t) => {
  const { service, project, root } = setup(t)
  const resolved = service.resolveProjectPath(project.id, 'assets/hero.png')
  assert.equal(resolved, path.join(fs.realpathSync.native(root), 'assets', 'hero.png'))
})

test('a single .. escape is refused', (t) => {
  const { service, project } = setup(t)
  assert.throws(() => service.resolveProjectPath(project.id, '../outside.txt'), /ESCAPES_ROOT/)
})

test('a multi-level ../../ escape is refused', (t) => {
  const { service, project } = setup(t)
  assert.throws(() => service.resolveProjectPath(project.id, '../../../../Windows/System32/x.dll'), /ESCAPES_ROOT/)
})

test('an absolute path outside the project is refused', (t) => {
  const { service, project, dir } = setup(t)
  assert.throws(() => service.resolveProjectPath(project.id, path.join(dir, 'elsewhere.txt')), /ESCAPES_ROOT/)
})

test('an unknown project is refused', (t) => {
  const { service } = setup(t)
  assert.throws(() => service.resolveProjectPath('proj-does-not-exist', 'a.txt'), /项目不存在/)
})

test('an empty path is refused', (t) => {
  const { service, project } = setup(t)
  assert.throws(() => service.resolveProjectPath(project.id, ''), /EMPTY/)
})

test('a junction pointing outside the project is refused', { skip: process.platform !== 'win32' ? 'windows only' : false }, (t) => {
  const { service, project, root } = setup(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')

  const link = path.join(root, 'escape')
  const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { encoding: 'utf8', windowsHide: true })
  if (made.status !== 0) {
    t.skip('could not create a junction: ' + String(made.stderr ?? '').slice(0, 120))
    return
  }
  assert.throws(() => service.resolveProjectPath(project.id, 'escape/secret.txt'), /ESCAPES_ROOT/)
})

test('a path that does not exist yet is still checked', (t) => {
  const { service, project, root } = setup(t)
  const resolved = service.resolveProjectPath(project.id, 'new/deep/file.txt')
  assert.equal(resolved, path.join(fs.realpathSync.native(root), 'new', 'deep', 'file.txt'))
  assert.throws(() => service.resolveProjectPath(project.id, '../new.txt'), /ESCAPES_ROOT/)
})
