/**
 * Project root containment, including the ways Windows lets a path escape.
 *
 * Every negative case here is a real escape route: `..`, another drive, a UNC path, and a
 * junction pointing outside the root. A string-prefix check passes all of them.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  assertInsideProject,
  isInsideRoot,
  inspectProjectRoot,
  isUncPath,
  ProjectPathError,
} = require('../dist/main/projects/paths.js')

function projectRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-root-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a path inside the project is allowed', (t) => {
  const root = projectRoot(t)
  const inside = path.join(root, 'assets', 'hero.png')
  fs.mkdirSync(path.dirname(inside), { recursive: true })
  fs.writeFileSync(inside, 'x')
  assert.equal(assertInsideProject(root, inside), fs.realpathSync.native(inside))
})

test('a path that climbs out with .. is refused', (t) => {
  const root = projectRoot(t)
  const outside = path.join(root, '..', 'elsewhere.txt')
  assert.throws(() => assertInsideProject(root, outside), (error) => {
    assert.equal(error instanceof ProjectPathError, true)
    assert.equal(error.code, 'ESCAPES_ROOT')
    return true
  })
})

test('a sibling directory with a shared prefix is not inside', (t) => {
  const root = projectRoot(t)
  const sibling = root + '-other'
  fs.mkdirSync(sibling, { recursive: true })
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))
  assert.equal(isInsideRoot(root, sibling), false, 'prefix matching would wrongly accept this')
  assert.throws(() => assertInsideProject(root, sibling), /ESCAPES_ROOT/)
})

test('a path on another drive is refused', (t) => {
  const root = projectRoot(t)
  const otherDrive = process.platform === 'win32' ? 'D:\\somewhere\\file.txt' : '/somewhere/file.txt'
  assert.throws(() => assertInsideProject(root, otherDrive), (error) => {
    assert.ok(['DIFFERENT_DRIVE', 'ESCAPES_ROOT'].includes(error.code), 'got ' + error.code)
    return true
  })
})

test('a UNC path is refused', (t) => {
  const root = projectRoot(t)
  assert.equal(isUncPath('\\\\server\\share\\file'), true)
  assert.throws(() => assertInsideProject(root, '\\\\server\\share\\file'), /UNC_NOT_ALLOWED/)
})

test('a relative path is refused rather than guessed', (t) => {
  const root = projectRoot(t)
  assert.throws(() => assertInsideProject(root, 'assets/hero.png'), /NOT_ABSOLUTE/)
})

test('an empty path is refused', (t) => {
  const root = projectRoot(t)
  assert.throws(() => assertInsideProject(root, ''), /EMPTY/)
})

test('a junction pointing outside the root is refused', { skip: process.platform !== 'win32' ? 'windows only' : false }, (t) => {
  const root = projectRoot(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not read me')

  const link = path.join(root, 'escape')
  const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { encoding: 'utf8', windowsHide: true })
  if (made.status !== 0) {
    t.skip('could not create a junction: ' + String(made.stderr ?? '').slice(0, 120))
    return
  }

  const throughLink = path.join(link, 'secret.txt')
  assert.throws(() => assertInsideProject(root, throughLink), (error) => {
    assert.equal(error.code, 'ESCAPES_ROOT', 'a junction must not be a way out: ' + error.code)
    return true
  })
})

test('a path that does not exist yet is still checked against the root', (t) => {
  const root = projectRoot(t)
  const future = path.join(root, 'new', 'deep', 'file.txt')
  assert.equal(assertInsideProject(root, future), path.join(fs.realpathSync.native(root), 'new', 'deep', 'file.txt'))
  assert.throws(() => assertInsideProject(root, path.join(root, '..', 'new.txt')), /ESCAPES_ROOT/)
})

test('inspectProjectRoot reports why a directory is unusable', (t) => {
  const root = projectRoot(t)
  assert.equal(inspectProjectRoot(root).ok, true)
  assert.equal(inspectProjectRoot('').code, 'EMPTY')
  assert.equal(inspectProjectRoot('relative/path').code, 'NOT_ABSOLUTE')
  assert.equal(inspectProjectRoot('\\\\server\\share').code, 'UNC_NOT_ALLOWED')
  assert.equal(inspectProjectRoot(path.join(root, 'missing')).code, 'NOT_A_DIRECTORY')

  const file = path.join(root, 'a-file.txt')
  fs.writeFileSync(file, 'x')
  assert.equal(inspectProjectRoot(file).code, 'NOT_A_DIRECTORY')
})
