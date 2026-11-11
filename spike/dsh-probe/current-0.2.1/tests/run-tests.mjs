#!/usr/bin/env node
/**
 * Regression tests for the PHASE 00 gates.
 *
 * The rule this file follows: a gate that has only ever been observed passing is not a
 * gate. Every check below is exercised at least once with input that must fail, and the
 * failure is asserted on the returned value or the process exit code — never on a log
 * line that happens to contain "FAIL".
 *
 * Nothing here touches the real `profile-locks`, the real `dsh-home` or the real
 * evidence directory: dependencies are exercised through `CC_LOCK_ROOT` / `CC_DSH_HOME`
 * / `CC_EVIDENCE_OUT` overrides, and every path fixture is built at runtime so this file
 * does not itself contain an absolute path.
 *
 * Usage: node tests/run-tests.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findLeaks, redactText, REPO_ROOT, HOME_DIR, PROBE_ROOT } from '../src/lib/redact.mjs'
import { scanTree } from '../src/lib/scrub.mjs'
import { out } from '../src/lib/safe-output.mjs'
import { classifyRun } from '../src/lib/diagnostics.mjs'
import { notificationsIsolated, routesAllMatch, summariseRoutes } from '../src/lib/assertions.mjs'
import { decideOverall, checkProjectState, loadStateCheck, STATE_DOC_POINTERS } from '../src/lib/gates.mjs'
import { setupProfiles, compareVersions, satisfiesRange } from '../scripts/setup-profiles.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BS = String.fromCharCode(92) // one backslash
const WIN = (...parts) => `C:${BS}${parts.join(BS)}`
const UNC = (server, ...parts) => `${BS}${BS}${server}${BS}${parts.join(BS)}`
const POSIX = (...parts) => parts.join('/')
const WINSP = (...parts) => `C:${BS}${parts.join(BS)}`
const FAKE_KEY = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
const FAKE_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnop'].join('.')
const DASH5 = String.fromCharCode(45).repeat(5)
const FAKE_PEM = `${DASH5}BEGIN RSA PRIVATE KEY${DASH5}\nMIIEowIBAAKCAQEA\n${DASH5}END RSA PRIVATE KEY${DASH5}`

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r14-'))
const made = (name) => {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Recursive copy: `fs.cpSync` is terminated by this host's safe-delete shim. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

const results = []

/**
 * Fault-injection seam for `record-tests.mjs`. Publishing must depend on the real exit
 * code, and the only honest way to test that is to make a run fail on purpose.
 */
if (process.env.CC_TEST_FAIL_INJECT === '1') {
  out('[tests] injected failure (fault-injection mode)\n')
  process.exit(1)
}

async function test(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - started })
    out(`PASS  ${name}\n`)
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 500) })
    out(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n')[0]}\n`)
  }
}

// ---------------------------------------------------------------------------
// P1: detection must catch real paths
// ---------------------------------------------------------------------------

const POSITIVE_CASES = [
  ['windows drive', WIN('Users', 'alice', 'notes.txt')],
  // R1.4.1: a general directory name with a space, NOT the special `Program Files`
  // root that a dedicated rule happens to recognise.
  ['windows spaces (general)', WINSP('Work Folder', 'project', 'file.txt')],
  ['windows spaces (deep)', WINSP('My Projects', 'AI Game Studio', 'src', 'main.ts')],
  ['windows program files', WIN('Program Files', 'Some App', 'bin', 'app.exe')],
  ['windows deep drive', `H:${BS}work${BS}proj${BS}src${BS}index.ts`],
  ['windows non-ascii', `H:${BS}AI与开发${BS}proj${BS}x`],
  ['windows forward', POSIX('C:', 'Users', 'alice', 'file.txt')],
  ['unc', UNC('fileserver', 'share', 'dir', 'file.txt')],
  ['posix mnt', POSIX('/mnt', 'data', 'proj', 'x')],
  ['posix tmp', POSIX('/tmp', 'work', 'x')],
  ['posix opt', POSIX('/opt', 'tool', 'lib', 'x.so')],
  ['posix home', POSIX('/home', 'alice', 'proj')],
  ['posix root', POSIX('/root', '.config', 'x')],
  ['posix workspace', POSIX('/workspace', 'src', 'x')],
  ['repository root', path.join(REPO_ROOT, 'docs', 'x.md')],
  ['user home', path.join(HOME_DIR, 'notes.txt')],
]

/** Credentials must be detected AND redacted by the very same rule set. */
const CREDENTIAL_CASES = [
  ['openai-style key', `key=${FAKE_KEY}`],
  ['github token', `token=ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`],
  ['aws key', `AWS ${FAKE_AWS}`],
  ['bearer token', `Authorization: Bearer ${'a1B2c3D4e5F6g7H8i9J0k1L2'}`],
  ['assigned api key', `COMMANDCODE_API_KEY=${'xyzABC1234567890uvw'}`],
  ['jwt', FAKE_JWT],
  ['private key', FAKE_PEM],
]

const NEGATIVE_CASES = [
  ['placeholder repo', '<repo>/docs/x.md'],
  ['placeholder home', '<user-home>/x'],
  ['placeholder host', 'host=<host>'],
  ['placeholder abs', 'path=<abs-path>'],
  ['placeholder credential', 'key=<credential>'],
  ['relative path', 'src/lib/redact.mjs'],
  ['url', 'https://example.com/home/user'],
  ['url with port', 'http://127.0.0.1:7890/tmp/x'],
  ['escape sequence', `note:${BS}n`],
  ['time', 'time: 10:30'],
  ['bare drive', 'C:'],
  ['api path', '/api/v1/users'],
  ['regex source', '/(?<![A-Za-z0-9])[A-Za-z]:' + BS + BS + '[^' + BS + BS + 's]*/g'],
  ['credential env name only', 'COMMANDCODE_API_KEY'],
  ['credential env indirection', 'apiKeyEnv: COMMANDCODE_API_KEY'],
  ['short sk prefix', 'sk-short'],
  ['npm integrity hash', 'sha512-j6ibijPAQAWHey9eDZb+yl+FOkAsImGVfspkvKUKbLcMoZOK7OWe9uGlbUjFG58xd0rj8ZVQT6RJkSrTeffkpQ=='],
]

for (const [label, sample] of POSITIVE_CASES) {
  await test(`detect: ${label}`, () => {
    const leaks = findLeaks(sample)
    assert.ok(leaks.length > 0, `expected a leak in ${JSON.stringify(sample)}`)
    assert.ok(redactText(sample).includes('<abs-path>') || redactText(sample).includes('<repo>') || redactText(sample).includes('<user-home>'), 'redaction must replace it')
  })
}

for (const [label, sample] of NEGATIVE_CASES) {
  await test(`ignore: ${label}`, () => {
    const leaks = findLeaks(sample)
    assert.deepEqual(leaks, [], `false positive on ${JSON.stringify(sample)}: ${JSON.stringify(leaks)}`)
  })
}

for (const [label, sample] of CREDENTIAL_CASES) {
  await test(`credential: ${label} is detected and redacted`, () => {
    const leaks = findLeaks(sample)
    assert.ok(
      leaks.some((l) => l.rule.startsWith('credential-')),
      `no credential rule fired for ${JSON.stringify(sample)}: ${JSON.stringify(leaks)}`,
    )
    const scrubbed = redactText(sample)
    assert.ok(scrubbed.includes('<credential>'), `not redacted: ${JSON.stringify(scrubbed)}`)
    assert.equal(findLeaks(scrubbed).filter((l) => l.rule.startsWith('credential-')).length, 0, 'redaction must be idempotent')
  })
}

// ---------------------------------------------------------------------------
// P1: scanner behaviour — scope, read failures, empty scope
// ---------------------------------------------------------------------------

await test('scan: planted leak is found', () => {
  const dir = made('planted')
  write(path.join(dir, 'note.md'), `# note\n\nabs: ${WIN('Users', 'alice', 'secret.txt')}\n`)
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.ok, false)
  assert.ok(result.leaks.length >= 1)
  assert.equal(result.leaks[0].file, 'note.md')
})

await test('scan: clean tree passes', () => {
  const dir = made('clean')
  write(path.join(dir, 'readme.md'), '# ok\n\nsee <repo>/docs and https://example.com/home/x\n')
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.ok, true, JSON.stringify(result.leaks))
  assert.equal(result.scanned, 1)
})

await test('scan: empty scope is an error, not a pass', () => {
  const dir = made('empty')
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.stage === 'scope'))
})

await test('scan: unreadable file is an error, not a pass', () => {
  const dir = made('unreadable')
  // A tracked file that no longer exists on disk: the list succeeds, the read cannot.
  // (A directory named `x.md` would simply be walked, not read, so it proves nothing.)
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
  if (git.status !== 0) return // no git available: nothing to prove here
  fs.writeFileSync(path.join(dir, 'tracked.md'), '# tracked\n')
  spawnSync('git', ['add', 'tracked.md'], { cwd: dir, encoding: 'utf8' })
  fs.unlinkSync(path.join(dir, 'tracked.md'))

  const result = scanTree({ root: dir, mode: 'git' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.stage === 'read'), JSON.stringify(result.errors))
})

await test('scan: json is inspected after decoding', () => {
  const dir = made('json')
  const payload = JSON.stringify({ path: WIN('Users', 'alice', 'file.txt') }, null, 2)
  write(path.join(dir, 'data.json'), `${payload}\n`)
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.ok, false)
  assert.equal(result.leaks[0].rule !== undefined, true)
})

await test('scan: extensionless and .orig files are in scope', () => {
  const dir = made('no-extension')
  write(path.join(dir, '.gitignore'), `${WIN('Users', 'alice', 'a.txt')}\n`)
  write(path.join(dir, 'package.json.orig'), `${POSIX('/tmp', 'leak', 'x')}\n`)
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.scanned, 2, JSON.stringify(result))
  assert.deepEqual([...result.leaks.map((l) => l.file)].sort(), ['.gitignore', 'package.json.orig'])
})

await test('scan: binary content is skipped by NUL detection, not by suffix', () => {
  const dir = made('binary')
  write(path.join(dir, 'blob.data'), `text\u0000binary`)
  write(path.join(dir, 'note.md'), 'clean\n')
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.ok, true)
  assert.equal(result.scanned, 1)
  assert.equal(result.skippedBinary, 1)
})

await test('scan: credential in a file is reported with its rule id', () => {
  const dir = made('credential-file')
  write(path.join(dir, 'note.txt'), `used ${FAKE_KEY} here\n`)
  const result = scanTree({ root: dir, mode: 'walk' })
  assert.equal(result.ok, false)
  assert.ok(result.leaks.some((l) => l.rule.startsWith('credential-')), JSON.stringify(result.leaks))
})

// ---------------------------------------------------------------------------
// P1: the CLI must exit non-zero, not just print
// ---------------------------------------------------------------------------

const CLI = path.resolve(PROBE_ROOT, '..', 'scrub-evidence.mjs')
const runCli = (dir) =>
  spawnSync(process.execPath, [CLI, '--check', '--root', dir, '--mode', 'walk'], { encoding: 'utf8' })

await test('cli: leak exits 1', () => {
  const dir = made('cli-leak')
  write(path.join(dir, 'a.md'), `x ${POSIX('/tmp', 'a', 'b')} y\n`)
  const run = runCli(dir)
  assert.equal(run.status, 1, run.stdout)
})

await test('cli: clean exits 0', () => {
  const dir = made('cli-clean')
  write(path.join(dir, 'a.md'), 'nothing to see\n')
  const run = runCli(dir)
  assert.equal(run.status, 0, run.stdout)
})

await test('cli: empty root exits 1', () => {
  const dir = made('cli-empty')
  const run = runCli(dir)
  assert.equal(run.status, 1, run.stdout)
})

// ---------------------------------------------------------------------------
// P3: classification from both streams
// ---------------------------------------------------------------------------

await test('classify: quota on stderr', () => {
  const c = classifyRun({ stdout: '', stderr: 'dsh: QUOTA: Insufficient Balance' })
  assert.equal(c.kind, 'QUOTA')
  assert.deepEqual(c.matchedIn, ['stderr'])
})

await test('classify: quota on stdout', () => {
  const c = classifyRun({ stdout: 'QUOTA: Insufficient Balance', stderr: '' })
  assert.equal(c.kind, 'QUOTA')
  assert.deepEqual(c.matchedIn, ['stdout'])
})

await test('classify: both streams', () => {
  const c = classifyRun({ stdout: 'auth failed: 401', stderr: 'unauthorized' })
  assert.equal(c.kind, 'AUTH')
  assert.deepEqual(c.matchedIn.sort(), ['stderr', 'stdout'])
})

await test('classify: plugin incompatibility outranks quota', () => {
  const c = classifyRun({ stdout: '', stderr: 'Plugin x is incompatible with dsh 0.2.1-rc.3\nQUOTA' })
  assert.equal(c.kind, 'PLUGIN_INCOMPATIBLE')
})

await test('classify: healthy run has no kind', () => {
  const c = classifyRun({ stdout: 'ok', stderr: '' })
  assert.equal(c.kind, null)
  assert.deepEqual(c.matchedIn, [])
})

await test('classify: unknown text stays unclassified', () => {
  const c = classifyRun({ stdout: 'something odd happened', stderr: 'and again' })
  assert.equal(c.kind, null)
})

// ---------------------------------------------------------------------------
// P3: route and isolation predicates must fail on the inputs that matter
// ---------------------------------------------------------------------------

const ROUTE = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }

await test('routes: empty list is not a pass', () => {
  assert.equal(routesAllMatch([], ROUTE), false)
})

await test('routes: single correct request passes', () => {
  assert.equal(routesAllMatch([ROUTE], ROUTE), true)
})

await test('routes: fallback on the second hop fails', () => {
  const routes = [ROUTE, { provider: 'deepseek-official', model: 'deepseek-chat' }]
  assert.equal(routesAllMatch(routes, ROUTE), false)
})

await test('routes: wrong model fails', () => {
  assert.equal(routesAllMatch([{ provider: ROUTE.provider, model: 'other' }], ROUTE), false)
})

await test('routes: shape records that only one hop was seen', () => {
  assert.equal(summariseRoutes([ROUTE]).multiHopObserved, false)
  assert.equal(summariseRoutes([ROUTE, ROUTE]).multiHopObserved, true)
})

await test('isolation: empty notification list fails', () => {
  assert.equal(notificationsIsolated([], 's1'), false)
})

await test('isolation: foreign session id fails', () => {
  assert.equal(notificationsIsolated(['s2'], 's1'), false)
})

await test('isolation: mixed list fails', () => {
  assert.equal(notificationsIsolated(['s1', 's2'], 's1'), false)
})

await test('isolation: own session passes', () => {
  assert.equal(notificationsIsolated(['s1', 's1'], 's1'), true)
})

// ---------------------------------------------------------------------------
// Gate arithmetic: a leak or a dependency failure must fail the run
// ---------------------------------------------------------------------------

await test('gate: leak failure alone fails the suite', () => {
  const v = decideOverall({ failed: 0, blocked: 0, dependency: 'PASS', leak: 'FAIL' })
  assert.equal(v.overall, 'FAIL')
  assert.equal(v.exitCode, 1)
})

await test('gate: dependency failure alone fails the suite', () => {
  const v = decideOverall({ failed: 0, blocked: 0, dependency: 'FAIL', leak: 'PASS' })
  assert.equal(v.overall, 'FAIL')
  assert.equal(v.exitCode, 1)
})

await test('gate: six passing probes cannot outvote a gate', () => {
  const v = decideOverall({ failed: 0, blocked: 0, dependency: 'PASS', leak: 'FAIL' })
  assert.equal(v.exitCode, 1)
})

await test('gate: blocked only is BLOCKED, not FAIL', () => {
  const v = decideOverall({ failed: 0, blocked: 3 })
  assert.equal(v.overall, 'BLOCKED')
  assert.equal(v.exitCode, 2)
})

await test('gate: all clear is PASS', () => {
  const v = decideOverall({})
  assert.equal(v.overall, 'PASS')
  assert.equal(v.exitCode, 0)
})

await test('gate: state failure alone fails the suite', () => {
  const v = decideOverall({ failed: 0, blocked: 0, dependency: 'PASS', leak: 'PASS', state: 'FAIL' })
  assert.equal(v.overall, 'FAIL')
  assert.equal(v.exitCode, 1)
  assert.equal(v.gateFailures, 1)
})

// ---------------------------------------------------------------------------
// Project-state gate: exactly one current record, complete, history preserved
// ---------------------------------------------------------------------------

const stateData = () => loadStateCheck(REPO_ROOT)

/** Check a deep-cloned state with one deliberate defect, leaving the real file alone. */
function withBrokenState(mutate, docs = null) {
  const data = stateData()
  const state = structuredClone(data.state)
  mutate(state)
  return checkProjectState({ state, docs: docs ?? data.docs, root: REPO_ROOT })
}

const expectCode = (result, code) => {
  assert.equal(result.ok, false, `expected a failure, got PASS: ${JSON.stringify(result.checked)}`)
  assert.ok(result.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(result.errors)}`)
}

await test('state: the real repository has one complete current record', () => {
  const result = checkProjectState(stateData())
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.checked.gates, 10)
  assert.equal(result.checked.deferred, 8)
  assert.ok(result.checked.unknown >= 1)
  assert.equal(result.checked.docs, STATE_DOC_POINTERS.length)
})

await test('state: missing authoritative pointer fails', () => {
  expectCode(withBrokenState((s) => delete s.authoritative_source), 'authority-missing')
})

await test('state: deleting the current record fails', () => {
  expectCode(withBrokenState((s) => delete s.phase_00_final), 'current-record-missing')
})

await test('state: a scope gate downgraded to BLOCKED fails', () => {
  expectCode(withBrokenState((s) => { s.phase_00_final.gates['03_real_prompt_trackable_result'].status = 'BLOCKED' }), 'gate-not-pass')
})

await test('state: a gate pointing at a missing evidence file fails', () => {
  expectCode(withBrokenState((s) => { s.phase_00_final.gates['05_studio_readonly_tool_invoked'].evidence = 'does/not/exist.json' }), 'gate-evidence-missing')
})

await test('state: a deferred item without a target phase fails', () => {
  expectCode(withBrokenState((s) => { delete s.phase_00_final.deferred.U1.phase }), 'deferred-incomplete')
})

await test('state: a deferred item claimed as CONFIRMED fails', () => {
  expectCode(withBrokenState((s) => { s.phase_00_final.deferred.U1.status = 'CONFIRMED' }), 'deferred-overclaimed')
})

await test('state: an UNKNOWN without a verification condition fails', () => {
  expectCode(withBrokenState((s) => { delete s.phase_00_final.unknown.K1.condition_to_verify }), 'unknown-incomplete')
})

await test('state: HY4 direct claimed as CONFIRMED fails', () => {
  expectCode(withBrokenState((s) => { s.phase_00_final.independent_verification.hy4_dsh_direct.status = 'CONFIRMED' }), 'hy4-status')
})

await test('state: HY4 direct marked as blocking fails', () => {
  expectCode(withBrokenState((s) => { s.phase_00_final.independent_verification.hy4_dsh_direct.blocking = true }), 'hy4-blocking')
})

await test('state: deleting a historical round record fails', () => {
  expectCode(withBrokenState((s) => { delete s.phase_00_r1.r141 }), 'history-lost')
})

await test('state: a document declaring a stale gate_results as current fails', () => {
  const docs = { ...stateData().docs }
  docs['docs/phase-reports/PHASE_00_REPORT.md'] = 'phase_00_final\n当前权威事实以 state/project_state.json 的 phase_00_r1.gate_results 为准；'
  const data = stateData()
  expectCode(checkProjectState({ state: data.state, docs, root: REPO_ROOT }), 'doc-stale-pointer')
})

await test('state: a document with no pointer to the current record fails', () => {
  const docs = { ...stateData().docs }
  docs['README.md'] = 'no pointer here'
  const data = stateData()
  expectCode(checkProjectState({ state: data.state, docs, root: REPO_ROOT }), 'doc-pointer-missing')
})

await test('state: an incomplete document set cannot pass by omission', () => {
  const docs = { 'README.md': stateData().docs['README.md'] }
  const data = stateData()
  expectCode(checkProjectState({ state: data.state, docs, root: REPO_ROOT }), 'doc-set-incomplete')
})

// ---------------------------------------------------------------------------
// Output layer: no raw stream writes outside the single writer
// ---------------------------------------------------------------------------

await test('output: no direct stream writes outside safe-output.mjs', () => {
  const files = [
    'run-all.mjs',
    'src/lib/evidence.mjs',
    'src/lib/gates.mjs',
    'scripts/setup-profiles.mjs',
    'scripts/run-gates.mjs',
    'tests/run-tests.mjs',
    'tests/record-tests.mjs',
  ]
  for (const rel of files) {
    const source = fs.readFileSync(path.join(PROBE_ROOT, rel), 'utf8')
    assert.equal(/process\.(stdout|stderr)\.write\(/.test(source), false, `${rel} bypasses the redacted output layer`)
  }
})

// ---------------------------------------------------------------------------
// Version range used by the dependency gate
// ---------------------------------------------------------------------------

await test('range: required dsh line is accepted', () => {
  assert.equal(satisfiesRange('0.2.1-rc.3', '>=0.2.1-rc.2 <0.2.2-0'), true)
})

await test('range: older runtime is rejected', () => {
  assert.equal(satisfiesRange('0.1.5-rc.1', '>=0.2.1-rc.2 <0.2.2-0'), false)
})

await test('range: newer runtime is rejected', () => {
  assert.equal(satisfiesRange('0.2.2-rc.1', '>=0.2.1-rc.2 <0.2.2-0'), false)
})

await test('range: unsupported syntax is UNKNOWN, not pass', () => {
  assert.equal(satisfiesRange('0.2.1-rc.3', '^0.2.1'), null)
})

await test('range: prerelease ordering', () => {
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.3'), -1)
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.3'), 1)
})

// ---------------------------------------------------------------------------
// P2: dependency scenarios, on a copy of the lockfiles
// ---------------------------------------------------------------------------

const LOCK_SOURCE = path.join(PROBE_ROOT, 'profile-locks')
const depRoot = made('deps')
const lockRoot = path.join(depRoot, 'locks')
copyTree(LOCK_SOURCE, lockRoot)
const depHome = path.join(depRoot, 'dsh-home')

const previous = { lockRoot: process.env.CC_LOCK_ROOT, home: process.env.CC_DSH_HOME }
process.env.CC_LOCK_ROOT = lockRoot
process.env.CC_DSH_HOME = depHome

const setup = () => setupProfiles({ home: depHome, patchDirectory: path.join(depRoot, 'patches'), log: () => {} })
const setupCodes = () => {
  try {
    setup()
    return null
  } catch (error) {
    return error?.code ?? error?.name
  }
}

await test('deps: fresh home builds both profiles', () => {
  const summary = setup()
  assert.equal(summary.profiles.length, 2)
  assert.equal(summary.runtime.status, 'COMPATIBLE')
})

await test('deps: second run is stable and repairs nothing', () => {
  const summary = setup()
  assert.equal(summary.profiles.every((p) => p.profileRepaired === false), true)
})

await test('deps: tampered install is repaired, not accepted', () => {
  const manifest = path.join(depHome, 'profiles', 'cc-sdk', 'node_modules', '@mars-sea', 'dsh-commandcode-provider', 'package.json')
  fs.appendFileSync(manifest, '\n')
  const summary = setup()
  assert.ok(summary.profiles.every((p) => p.plugin.files > 0))
  // after repair the tree matches again
  const again = setup()
  assert.equal(again.profiles.every((p) => p.profileRepaired === false), true)
})

await test('deps: tampered profile manifest is repaired', () => {
  const manifest = path.join(depHome, 'profiles', 'cc-cli', 'package.json')
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  value.dsh.profile.bundles = ['@deepseek-ai/dsh-base']
  fs.writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`)
  const summary = setup()
  assert.ok(summary.profiles.some((p) => p.profileRepaired === true))
})

await test('deps: missing lockfile fails', () => {
  const tree = path.join(lockRoot, 'cc-sdk', 'tree.json')
  const backup = fs.readFileSync(tree, 'utf8')
  fs.unlinkSync(tree)
  try {
    assert.equal(setupCodes(), 'lock-missing')
  } finally {
    fs.writeFileSync(tree, backup)
  }
})

await test('deps: lockfile version drift fails', () => {
  const lockFile = path.join(lockRoot, 'cc-cli', 'package-lock.json')
  const backup = fs.readFileSync(lockFile, 'utf8')
  const lock = JSON.parse(backup)
  lock.packages['node_modules/@mars-sea/dsh-commandcode-provider'].version = '0.15.3'
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
  try {
    assert.equal(setupCodes(), 'lock-version-mismatch')
  } finally {
    fs.writeFileSync(lockFile, backup)
  }
})

await test('deps: lockfile manifest drift fails', () => {
  const manifest = path.join(lockRoot, 'cc-sdk', 'package.json')
  const backup = fs.readFileSync(manifest, 'utf8')
  const value = JSON.parse(backup)
  value.dependencies['@mars-sea/dsh-commandcode-provider'] = '0.15.0'
  fs.writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`)
  try {
    assert.equal(setupCodes(), 'lock-manifest-mismatch')
  } finally {
    fs.writeFileSync(manifest, backup)
  }
})

await test('deps: corrupted lockfile fails with a code', () => {
  const lockFile = path.join(lockRoot, 'cc-sdk', 'package-lock.json')
  const backup = fs.readFileSync(lockFile, 'utf8')
  fs.writeFileSync(lockFile, '{ not json')
  try {
    assert.equal(setupCodes(), 'lock-invalid')
  } finally {
    fs.writeFileSync(lockFile, backup)
  }
})

await test('deps: tree integrity drift fails', () => {
  const treeFile = path.join(lockRoot, 'cc-sdk', 'tree.json')
  const backup = fs.readFileSync(treeFile, 'utf8')
  const tree = JSON.parse(backup)
  tree.integrity = 'sha512-tampered'
  fs.writeFileSync(treeFile, `${JSON.stringify(tree, null, 2)}\n`)
  try {
    assert.equal(setupCodes(), 'tree-integrity-mismatch')
  } finally {
    fs.writeFileSync(treeFile, backup)
  }
})

await test('deps: tree resolved drift fails', () => {
  const treeFile = path.join(lockRoot, 'cc-cli', 'tree.json')
  const backup = fs.readFileSync(treeFile, 'utf8')
  const tree = JSON.parse(backup)
  tree.resolved = 'https://example.invalid/other.tgz'
  fs.writeFileSync(treeFile, `${JSON.stringify(tree, null, 2)}\n`)
  try {
    assert.equal(setupCodes(), 'tree-resolved-mismatch')
  } finally {
    fs.writeFileSync(treeFile, backup)
  }
})

await test('deps: lockfile integrity drift fails even with a cached staging tree', () => {
  const lockFile = path.join(lockRoot, 'cc-sdk', 'package-lock.json')
  const backup = fs.readFileSync(lockFile, 'utf8')
  const lock = JSON.parse(backup)
  lock.packages['node_modules/@mars-sea/dsh-commandcode-provider'].integrity = 'sha512-tampered'
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
  try {
    assert.equal(setupCodes(), 'tree-integrity-mismatch')
  } finally {
    fs.writeFileSync(lockFile, backup)
  }
})

await test('deps: lockfile resolved drift fails', () => {
  const lockFile = path.join(lockRoot, 'cc-cli', 'package-lock.json')
  const backup = fs.readFileSync(lockFile, 'utf8')
  const lock = JSON.parse(backup)
  lock.packages['node_modules/@mars-sea/dsh-commandcode-provider'].resolved = 'https://example.invalid/x.tgz'
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
  try {
    assert.equal(setupCodes(), 'tree-resolved-mismatch')
  } finally {
    fs.writeFileSync(lockFile, backup)
  }
})

process.env.CC_LOCK_ROOT = previous.lockRoot
process.env.CC_DSH_HOME = previous.home

// ---------------------------------------------------------------------------
// End to end: a failing gate produces exit 1 and a FAIL aggregate
// ---------------------------------------------------------------------------

await test('suite: dependency gate failure exits 1', () => {  const evidenceOut = path.join(depRoot, 'evidence')
  const brokenLocks = path.join(depRoot, 'broken-locks')
  copyTree(LOCK_SOURCE, brokenLocks)
  const lockFile = path.join(brokenLocks, 'cc-sdk', 'tree.json')
  fs.unlinkSync(lockFile)

  const run = spawnSync(process.execPath, [path.join(PROBE_ROOT, 'run-all.mjs')], {
    cwd: PROBE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CC_LOCK_ROOT: brokenLocks,
      CC_DSH_HOME: path.join(depRoot, 'broken-home'),
      CC_EVIDENCE_OUT: evidenceOut,
    },
  })

  assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${String(run.stdout).slice(-400)}`)
  const aggregate = JSON.parse(fs.readFileSync(path.join(evidenceOut, '_aggregate', 'run-all.json'), 'utf8'))
  assert.equal(aggregate.gates.dependency.status, 'FAIL')
  assert.equal(aggregate.overall, 'FAIL')
  assert.equal(aggregate.total, 0, 'no probe should have run')
})

await test('suite: broken project state aborts before any probe (real exit code)', () => {
  const stateRoot = made('state-gate')
  const brokenStateFile = path.join(stateRoot, 'project_state.json')
  const data = loadStateCheck(REPO_ROOT)
  const broken = structuredClone(data.state)
  broken.phase_00_final.gates['05_studio_readonly_tool_invoked'].status = 'BLOCKED'
  fs.writeFileSync(brokenStateFile, `${JSON.stringify(broken, null, 2)}\n`)

  const evidenceOut = path.join(stateRoot, 'evidence')
  const run = spawnSync(process.execPath, [path.join(PROBE_ROOT, 'run-all.mjs')], {
    cwd: PROBE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CC_STATE_FILE: brokenStateFile,
      CC_EVIDENCE_OUT: evidenceOut,
    },
  })

  assert.equal(run.status, 1, `expected exit 1, got ${run.status}: ${String(run.stdout).slice(-500)}`)
  const aggregate = JSON.parse(fs.readFileSync(path.join(evidenceOut, '_aggregate', 'run-all.json'), 'utf8'))
  assert.equal(aggregate.gates.state.status, 'FAIL')
  assert.equal(aggregate.overall, 'FAIL')
  assert.equal(aggregate.total, 0, 'no probe should have run')
})

await test('evidence: a failing test run cannot overwrite the published result', () => {
  const published = path.join(PROBE_ROOT, 'evidence', 'r14', 'tests.json')
  const before = fs.existsSync(published) ? fs.readFileSync(published, 'utf8') : null
  const run = spawnSync(process.execPath, [path.join(HERE, 'record-tests.mjs')], {
    cwd: PROBE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CC_TEST_FAIL_INJECT: '1' },
  })
  assert.equal(run.status, 1, `expected the injected failure to exit 1, got ${run.status}`)
  const after = fs.existsSync(published) ? fs.readFileSync(published, 'utf8') : null
  assert.equal(after, before, 'published tests.json was modified by a failing run')
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  exitCode: failed.length ? 1 : 0,
  results,
}
/**
 * Where the machine-readable result goes.
 *
 * A test run that is deliberately broken (or simply fails) must not be able to
 * overwrite the published evidence. By default the result lands in a throwaway
 * directory; `tests/record-tests.mjs` points this at `evidence/r14/tests.json` and
 * copies it there only when the run exits 0.
 */
const resultFile = process.env.CC_TEST_EVIDENCE_OUT
  ? path.resolve(process.env.CC_TEST_EVIDENCE_OUT)
  : path.join(TMP, 'tests.json')
fs.mkdirSync(path.dirname(resultFile), { recursive: true })
fs.writeFileSync(resultFile, `${JSON.stringify(redactResult(summary), null, 2)}\n`)
out(`[tests] result: ${resultFile}\n`)

function redactResult(value) {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactResult)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactResult(v)
    return out
  }
  return value
}

out(`\n${summary.passed}/${summary.total} tests passed\n`)
process.exitCode = summary.exitCode
