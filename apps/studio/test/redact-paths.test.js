/**
 * Path redaction in evidence text.
 *
 * The bug these tests exist for: the first redactor matched `[^"'\r\n]*` after a drive
 * letter, so it swallowed everything to the end of the line. "H: 盘 store（H:\\dev\\pnpm-store\\v11）
 * 发生失败" became "H: 盘 store（<store-path>" — the closing bracket and the conclusion were
 * gone. Evidence that loses its conclusion is worse than evidence that shows a path.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { redactPaths, redactDeep, placeholderFor } = require('../scripts/lib/redact-paths.mjs')

const balanced = (text) => {
  const open = (text.match(/[（(]/g) ?? []).length
  const close = (text.match(/[）)]/g) ?? []).length
  return open === close
}

test('a bare path is replaced and nothing else changes', () => {
  assert.equal(redactPaths('H:\\dev\\pnpm-store\\v11'), '<H-drive-pnpm-store>')
})

test('text after the path survives, including full-width brackets', () => {
  const input = 'H:\\dev\\pnpm-store\\v11（失败）'
  const output = redactPaths(input)
  assert.equal(output, '<H-drive-pnpm-store>（失败）')
  assert.equal(balanced(output), true)
})

test('a path inside a sentence keeps the words on both sides', () => {
  const input = 'store 位于 H:\\dev\\pnpm-store\\v11 时安装失败'
  assert.equal(redactPaths(input), 'store 位于 <H-drive-pnpm-store> 时安装失败')
})

test('a temp store is distinguishable from an H: drive store', () => {
  const temp = redactPaths('C:\\Users\\LIN\\AppData\\Local\\Temp\\pnpm-store')
  assert.equal(temp, '<C-temp-pnpm-store>')
  assert.notEqual(temp, redactPaths('H:\\dev\\pnpm-store\\v11'), 'different stores must not collapse to one placeholder')
})

test('two paths in one sentence are both replaced and the punctuation survives', () => {
  const input = '失败 store（H:\\dev\\pnpm-store\\v11），成功 store（C:\\Users\\LIN\\AppData\\Local\\Temp\\pnpm-store-ags-r7）。'
  const output = redactPaths(input)
  assert.equal(output, '失败 store（<H-drive-pnpm-store>），成功 store（<C-temp-pnpm-store>）。')
  assert.equal(balanced(output), true)
})

test('text with no absolute path is returned unchanged', () => {
  const input = '没有绝对路径的普通文字，只有 H: 盘和 C: 盘的说法。'
  assert.equal(redactPaths(input), input, 'a bare drive reference is not a path')
})

test('a drive letter followed by a space is not treated as a path', () => {
  assert.equal(redactPaths('H: 盘 store 失败'), 'H: 盘 store 失败')
  assert.equal(redactPaths('C: 盘正常'), 'C: 盘正常')
})

test('the conclusion of a real evidence sentence is preserved', () => {
  const input = 'C: 盘 %TEMP% 下的独立 store 可正常 registerProject；H: 盘上的 store（H:\\dev、H:\\ai_music_crew\\.tmp）仍会在 projects/<hash> 上失败'
  const output = redactPaths(input)
  assert.match(output, /仍会在 projects\/<hash> 上失败$/, 'the conclusion must survive: ' + output)
  assert.equal(balanced(output), true)
  assert.equal(output.includes('H:\\dev'), false, 'no real path may remain')
})

test('placeholders are chosen by meaning, not by position', () => {
  assert.equal(placeholderFor('H:\\dev\\pnpm-store\\v11'), '<H-drive-pnpm-store>')
  assert.equal(placeholderFor('C:\\Users\\x\\AppData\\Local\\Temp\\pnpm-store'), '<C-temp-pnpm-store>')
  assert.equal(placeholderFor('H:\\workbuddy\\AI_Game_Studio\\release-r5\\win-unpacked'), '<install-directory>')
  assert.equal(placeholderFor('C:\\Users\\someone\\Documents\\x'), '<user-home>')
})

test('redactDeep walks arrays and nested objects', () => {
  const input = { a: ['H:\\dev\\pnpm-store\\v11（失败）'], b: { c: 'C: 盘正常' } }
  const output = redactDeep(input)
  assert.deepEqual(output, { a: ['<H-drive-pnpm-store>（失败）'], b: { c: 'C: 盘正常' } })
})

test('no unclosed placeholder is ever produced', () => {
  const samples = [
    'H:\\dev\\pnpm-store\\v11（失败）',
    'store 位于 H:\\dev\\pnpm-store\\v11 时安装失败',
    '失败 store（H:\\dev\\pnpm-store\\v11），成功 store（C:\\Users\\LIN\\AppData\\Local\\Temp\\pnpm-store-ags-r7）。',
  ]
  for (const sample of samples) {
    const output = redactPaths(sample)
    assert.equal(balanced(output), true, 'unbalanced brackets in: ' + output)
    assert.equal(/<store-path>$/.test(output), false, 'a truncated placeholder leaked: ' + output)
  }
})
