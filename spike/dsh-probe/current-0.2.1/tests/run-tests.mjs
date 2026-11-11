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
import {
  decideOverall,
  checkProjectState,
  checkEvidencePath,
  resolveContainedRealPath,
  officialStateFile,
  isInsideDirectory,
  staysInside,
  loadStateCheck,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FILES,
  EVIDENCE_CONTENT_RULES,
  STATE_DOC_POINTERS,
} from '../src/lib/gates.mjs'
import { parseExitCode, EXIT_CODE_PATTERN } from '../src/lib/exitcode.mjs'
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
function withBrokenState(mutate, docs = null, root = REPO_ROOT) {
  const data = stateData()
  const state = structuredClone(data.state)
  mutate(state)
  return checkProjectState({ state, docs: docs ?? data.docs, root })
}

const expectCode = (result, code) => {
  assert.equal(result.ok, false, `expected a failure, got PASS: ${JSON.stringify(result.checked)}`)
  assert.ok(result.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(result.errors)}`)
}

await test('state: the real repository has one complete current record', () => {
  const result = checkProjectState(stateData())
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.checked.gates, 10)
  assert.ok(result.checked.deferred >= 8, `expected at least 8 deferred items, got ${result.checked.deferred}`)
  assert.equal(
    Object.keys(stateData().state.phase_00_final.deferred).every((id) => /^U\d+$/.test(id)),
    true,
    'deferred ids use the U<n> form',
  )
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
// PHASE 00 convergence: the state gate must fail for the reasons it claims
// ---------------------------------------------------------------------------
// The first version of the gate checked `length === 10` for gates and a count for
// documents, so a swapped gate and four unrelated documents both passed. Every case
// below is the exploit that used to work, asserted on the returned code.

/** Assert that the result failed AND carries every one of these codes. */
const expectCodes = (result, codes) => {
  assert.equal(result.ok, false, `expected a failure, got PASS: ${JSON.stringify(result.checked)}`)
  for (const code of codes) {
    assert.ok(result.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(result.errors)}`)
  }
}

/** A scratch root used only as an evidence-path anchor; docs are injected in memory. */
const evidenceRoot = made('evidence-fixtures')

await test('gates: exactly the ten PHASE 00 scope ids are required', () => {
  assert.equal(REQUIRED_GATE_IDS.length, 10)
  assert.equal(new Set(REQUIRED_GATE_IDS).size, 10)
  const gates = stateData().state.phase_00_final.gates
  assert.deepEqual(Object.keys(gates).sort(), [...REQUIRED_GATE_IDS].sort())
})

await test('state: swapping a real gate for an invented one keeps the count at ten and still fails', () => {
  const result = withBrokenState((s) => {
    const gates = s.phase_00_final.gates
    const borrowed = structuredClone(gates['03_real_prompt_trackable_result'])
    delete gates['06_runtime_exit_code_recorded']
    gates['06_runtime_exit_code_recorded_INVENTED'] = borrowed
    assert.equal(Object.keys(gates).length, 10, 'the exploit depends on the count staying 10')
  })
  expectCodes(result, ['gate-id-missing', 'gate-id-unknown'])
})

await test('state: a PASS verdict with a non-passing gate is rejected', () => {
  const result = withBrokenState((s) => {
    s.phase_00_final.verdict = 'PASS'
    s.phase_status.PHASE_00 = 'PASS'
    s.phase_00_final.gates['06_runtime_exit_code_recorded'].status = 'BLOCKED'
  })
  expectCodes(result, ['verdict-overclaimed'])
})

await test('state: a PASS verdict with non-empty blocking items is rejected', () => {
  const result = withBrokenState((s) => {
    s.phase_00_final.verdict = 'PASS'
    s.phase_status.PHASE_00 = 'PASS'
    s.phase_00_final.blocking_items = ['still blocked']
  })
  expectCode(result, 'verdict-overclaimed')
})

await test('state: a verdict with no reason is rejected', () => {
  expectCode(withBrokenState((s) => { delete s.phase_00_final.verdict_reason }), 'verdict-no-reason')
})

await test('state: an extra invented gate on top of the real ten fails', () => {
  const result = withBrokenState((s) => {
    s.phase_00_final.gates['11_made_up'] = structuredClone(s.phase_00_final.gates['08_tech_selection_adr'])
  })
  expectCode(result, 'gate-id-unknown')
})

await test('state: four wrong-named documents that all say phase_00_final fail', () => {
  const docs = {
    'docs/notes/A.md': 'phase_00_final',
    'notes/B.md': 'phase_00_final',
    'docs/C.md': 'phase_00_final',
    'README.old.md': 'phase_00_final',
  }
  const data = stateData()
  const result = checkProjectState({ state: data.state, docs, root: REPO_ROOT })
  expectCodes(result, ['doc-set-incomplete'])
  for (const rel of STATE_DOC_POINTERS) {
    assert.ok(
      result.errors.some((e) => e.code === 'doc-set-incomplete' && e.message.includes(rel)),
      `the missing required document ${rel} must be named`,
    )
  }
})

await test('state: dropping any one required pointer document fails and names it', () => {
  for (const rel of STATE_DOC_POINTERS) {
    const docs = { ...stateData().docs }
    delete docs[rel]
    const data = stateData()
    const result = checkProjectState({ state: data.state, docs, root: REPO_ROOT })
    expectCode(result, 'doc-set-incomplete')
    assert.ok(result.errors.some((e) => e.message.includes(rel)), `missing document not named: ${rel}`)
  }
})

await test('state: an empty pointer document fails', () => {
  const docs = { ...stateData().docs }
  docs['README.md'] = '   \n\t  '
  const data = stateData()
  expectCodes(checkProjectState({ state: data.state, docs, root: REPO_ROOT }), ['doc-pointer-missing', 'doc-empty'])
})

await test('evidence: a missing file fails', () => {
  const result = checkEvidencePath(evidenceRoot, 'does/not/exist.json')
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'gate-evidence-missing')
})

await test('evidence: an empty file fails', () => {
  fs.mkdirSync(path.join(evidenceRoot, 'empty'), { recursive: true })
  fs.writeFileSync(path.join(evidenceRoot, 'empty', 'summary.json'), '')
  const result = checkEvidencePath(evidenceRoot, 'empty/summary.json')
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'gate-evidence-empty')
})

await test('evidence: a directory is not a file', () => {
  fs.mkdirSync(path.join(evidenceRoot, 'a-directory.json'), { recursive: true })
  const result = checkEvidencePath(evidenceRoot, 'a-directory.json')
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'gate-evidence-not-file')
})

await test('evidence: corrupt JSON fails', () => {
  write(path.join(evidenceRoot, 'corrupt', 'summary.json'), '{ "probe": "x", ')
  const result = checkEvidencePath(evidenceRoot, 'corrupt/summary.json')
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'gate-evidence-unparsable')
})

await test('evidence: corrupt JSONL fails on the offending line', () => {
  write(path.join(evidenceRoot, 'corrupt', 'records.jsonl'), '{"ts":"1","type":"ok"}\n{ not json }\n')
  const result = checkEvidencePath(evidenceRoot, 'corrupt/records.jsonl')
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'gate-evidence-unparsable')
  assert.ok(result.errors[0].message.includes('line 2'), result.errors[0].message)
})

await test('evidence: a valid JSONL file passes', () => {
  write(path.join(evidenceRoot, 'valid', 'records.jsonl'), '{"a":1}\n{"b":2}\n')
  assert.equal(checkEvidencePath(evidenceRoot, 'valid/records.jsonl').ok, true)
})

await test('evidence: markdown is not parsed as JSON', () => {
  write(path.join(evidenceRoot, 'valid', 'notes.md'), '# heading\n\nnot json at all: {\n')
  const result = checkEvidencePath(evidenceRoot, 'valid/notes.md')
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.kind, '.md')
})

await test('evidence: a path traversal is rejected', () => {
  for (const rel of ['../outside.json', 'docs/../../outside.json', BS + 'absolute', 'C:' + BS + 'Windows' + BS + 'win.ini']) {
    const result = checkEvidencePath(evidenceRoot, rel)
    assert.equal(result.ok, false, `traversal accepted: ${rel}`)
    assert.ok(
      ['gate-evidence-escape', 'gate-evidence-missing'].includes(result.errors[0].code),
      `unexpected code for ${rel}: ${result.errors[0].code}`,
    )
  }
  assert.equal(checkEvidencePath(evidenceRoot, '../outside.json').errors[0].code, 'gate-evidence-escape')
})

await test('evidence: staysInside resolves before comparing', () => {
  assert.equal(staysInside(evidenceRoot, 'valid/notes.md'), true)
  assert.equal(staysInside(evidenceRoot, '../escape.md'), false)
  assert.equal(staysInside(evidenceRoot, 'valid/../../../escape.md'), false)
  assert.equal(staysInside(evidenceRoot, ''), false)
})

await test('state: a gate whose evidence is empty fails', () => {
  fs.mkdirSync(path.join(evidenceRoot, 'state-empty'), { recursive: true })
  fs.writeFileSync(path.join(evidenceRoot, 'state-empty', 'summary.json'), '')
  const result = withBrokenState((s) => {
    s.phase_00_final.gates['05_studio_readonly_tool_invoked'].evidence = 'state-empty/summary.json'
  }, null, evidenceRoot)
  expectCode(result, 'gate-evidence-empty')
})

await test('state: a gate whose evidence path escapes the repository fails', () => {
  const result = withBrokenState((s) => {
    s.phase_00_final.gates['05_studio_readonly_tool_invoked'].evidence = '../../secrets.json'
  }, null, evidenceRoot)
  expectCode(result, 'gate-evidence-escape')
})

await test('state: every declared evidence path really resolves', () => {
  const data = stateData()
  for (const [id, gate] of Object.entries(data.state.phase_00_final.gates)) {
    const result = checkEvidencePath(REPO_ROOT, gate.evidence)
    assert.equal(result.ok, true, `${id} -> ${gate.evidence}: ${JSON.stringify(result.errors)}`)
    assert.ok(REQUIRED_GATE_IDS.includes(id), `unexpected gate id ${id}`)
  }
})

await test('evidence: gate 6 must actually carry the exit code it claims', () => {
  const data = stateData()
  const gate = data.state.phase_00_final.gates['06_runtime_exit_code_recorded']
  const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, gate.evidence), 'utf8'))
  const serialised = JSON.stringify(parsed)
  assert.equal(/"exitCode"\s*:\s*-?\d+/.test(serialised), true, 'gate 6 evidence must record an integer exitCode')
  assert.equal(/graceful/i.test(serialised) && /forced|kill/i.test(serialised), true, 'both teardown paths must be recorded')
})

await test('evidence: the old cc-3 evidence cannot satisfy gate 6 any more', () => {
  // This is the exact defect the external review found: valid JSON, no exit code,
  // gate declared PASS on it. Pointing gate 6 back at it must fail on content.
  const result = withBrokenState((s) => {
    s.phase_00_final.gates['06_runtime_exit_code_recorded'].evidence =
      'spike/dsh-probe/current-0.2.1/evidence/cc-3-resume/summary.json'
  })
  expectCode(result, 'gate-evidence-content')
})

await test('evidence: a gate without a content rule is unaffected by content rules', () => {
  const result = withBrokenState((s) => {
    s.phase_00_final.gates['03_real_prompt_trackable_result'].evidence =
      'spike/dsh-probe/current-0.2.1/evidence/cc-3-resume/summary.json'
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

// ---------------------------------------------------------------------------
// R15.1: review found two ways the verifier could still be lied to
// ---------------------------------------------------------------------------
// 1. `staysInside` is lexical, so a junction inside the repo pointing outside it passed
//    the check while fs.statSync/readFileSync followed the link. Windows junctions need
//    no privileges, which makes this the practical attack, not a theoretical one.
// 2. gate 6 accepted `noExitCodeReason` as if it were a recorded exit code.

/** A repo root plus a directory outside it, wired together with a link. */
function linkFixture(name) {
  const base = made(name)
  const root = path.join(base, 'repo')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"stolen":true}\n')

  const link = path.join(root, 'evidence', 'external-link')
  let created = null
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(outside, link, type)
      created = type
      break
    } catch {
      /* try the next link flavour */
    }
  }
  // A security test that silently skips is the false green this whole round is about.
  assert.ok(
    created !== null,
    'this host cannot create a directory link (junction or symlink), so the containment check cannot be proven here',
  )
  return { root, outside, link, kind: created }
}

await test('evidence: a junction that leaves the repository root is rejected', () => {
  const { root } = linkFixture('realpath-escape')
  // The lexical path is inside the repo; the real target is not.
  assert.equal(staysInside(root, 'evidence/external-link/secret.json'), true, 'the lexical check alone still accepts it')
  const contained = resolveContainedRealPath(root, 'evidence/external-link/secret.json')
  assert.equal(contained.ok, false, 'real path must be refused')
  assert.equal(contained.code, 'gate-evidence-escape')

  const check = checkEvidencePath(root, 'evidence/external-link/secret.json')
  assert.equal(check.ok, false)
  assert.equal(check.errors[0].code, 'gate-evidence-escape')
})

await test('evidence: a link that stays inside the repository root is allowed', () => {
  const base = made('realpath-inside')
  fs.mkdirSync(path.join(base, 'evidence', 'real'), { recursive: true })
  fs.writeFileSync(path.join(base, 'evidence', 'real', 'summary.json'), '{"ok":true}\n')
  fs.symlinkSync(path.join(base, 'evidence', 'real'), path.join(base, 'evidence', 'alias'), 'junction')
  const check = checkEvidencePath(base, 'evidence/alias/summary.json')
  assert.equal(check.ok, true, JSON.stringify(check.errors))
})

await test('evidence: a junctioned path to a missing file still fails on the ancestor', () => {
  const { root } = linkFixture('realpath-missing-tail')
  // File does not exist, but its nearest existing ancestor resolves outside the repo.
  const contained = resolveContainedRealPath(root, 'evidence/external-link/not-there.json')
  assert.equal(contained.ok, false)
  assert.equal(contained.code, 'gate-evidence-escape')
})

await test('evidence: isInsideDirectory is not a string prefix test', () => {
  const parent = path.join(BS, 'repo', 'root')
  assert.equal(isInsideDirectory(parent, path.join(parent, 'a', 'b.json')), true)
  assert.equal(isInsideDirectory(parent, parent), false)
  assert.equal(isInsideDirectory(parent, path.join(BS, 'repo', 'root-evil', 'x.json')), false)
  assert.equal(isInsideDirectory(parent, path.join(BS, 'repo', 'root', '..', 'outside-x')), false)
})

await test('state: a gate is resolved through links, not just spelled correctly', () => {
  const data = stateData()
  const { root } = linkFixture('realpath-state')
  const result = checkProjectState({
    state: {
      ...structuredClone(data.state),
      phase_00_final: {
        ...structuredClone(data.state.phase_00_final),
        gates: {
          ...structuredClone(data.state.phase_00_final.gates),
          '05_studio_readonly_tool_invoked': {
            ...structuredClone(data.state.phase_00_final.gates['05_studio_readonly_tool_invoked']),
            evidence: 'evidence/external-link/secret.json',
          },
        },
      },
    },
    docs: data.docs,
    root,
  })
  assert.equal(result.ok, false)
  assert.ok(
    result.errors.some((e) => e.code === 'gate-evidence-escape'),
    JSON.stringify(result.errors.map((e) => e.code)),
  )
})

// ---------------------------------------------------------------------------
// R15.2: review found the containment only covered evidence, and gate 6 too loose
// ---------------------------------------------------------------------------
// The link-escape fix protected `checkEvidencePath` but not `loadStateCheck`, so
// `state/` or `docs/review-handoff/` could itself be a junction. And the gate-6 rule
// still accepted any integer `exitCode` found anywhere in the JSON.

/** A repo root whose `state/` is a junction out of the repository. */
function stateEscapeFixture(name) {
  const base = made(name)
  const root = path.join(base, 'repo')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'project_state.json'), JSON.stringify({ authoritative_source: { current_record: 'phase_00_final' } }))
  let created = null
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(outside, path.join(root, 'state'), type)
      created = type
      break
    } catch {
      /* next flavour */
    }
  }
  assert.ok(created !== null, 'this host cannot create a directory link, so state containment cannot be proven')
  return { root, outside }
}

/** A repo root whose `docs/review-handoff/` is a junction out of the repository. */
function docEscapeFixture(name) {
  const base = made(name)
  const root = path.join(base, 'repo')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(root, 'state', 'project_state.json'), JSON.stringify({ authoritative_source: { current_record: 'phase_00_final' } }))
  fs.writeFileSync(path.join(root, 'README.md'), 'phase_00_final\n')
  fs.writeFileSync(path.join(outside, 'PHASE_00_R1_WORK_REPORT.md'), 'phase_00_final\n')
  let created = null
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(outside, path.join(root, 'docs', 'review-handoff'), type)
      created = type
      break
    } catch {
      /* next flavour */
    }
  }
  assert.ok(created !== null, 'this host cannot create a directory link, so doc containment cannot be proven')
  return { root, outside }
}

await test('state: a state/ junction out of the repository is rejected', () => {
  const { root } = stateEscapeFixture('state-escape')
  const loaded = loadStateCheck(root)
  assert.ok(
    loaded.violations.some((v) => v.code === 'state-escape'),
    `expected state-escape, got ${JSON.stringify(loaded.violations)}`,
  )
  const result = checkProjectState(loaded)
  assert.equal(result.ok, false)
  expectCode(result, 'state-escape')
})

await test('state: an escaped state file is not read at all', () => {
  const { root, outside } = stateEscapeFixture('state-escape-no-read')
  // If the loader still read the escaped target it would have to parse this.
  fs.writeFileSync(path.join(outside, 'project_state.json'), '<< not json at all >>')
  let loaded
  assert.doesNotThrow(() => {
    loaded = loadStateCheck(root)
  }, 'an escaped state file must not be read, let alone parsed')
  assert.equal(loaded.state, null, 'no state object may come from outside the repository')
  assert.ok(
    loaded.violations.some((v) => v.code === 'state-escape'),
    JSON.stringify(loaded.violations),
  )
  const result = checkProjectState(loaded)
  assert.equal(result.ok, false)
  expectCodes(result, ['state-escape', 'state-unreadable'])
})

await test('official: no override means "grade the repository state"', () => {
  const plain = officialStateFile({})
  assert.equal(plain.ok, true)
  assert.equal(plain.file, null)
  assert.equal(plain.testOverride, false)
})

await test('official: an override without a test run is refused', () => {
  const refused = officialStateFile({ CC_STATE_FILE: path.join(BS, 'outside', 'project_state.json') })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'state-override-forbidden')
  const empty = officialStateFile({ CC_STATE_FILE: '' })
  assert.equal(empty.ok, true, 'an empty override is not an override')
})

await test('official: a test run may inject, and says so', () => {
  const result = officialStateFile({ CC_STATE_FILE: 'somewhere/project_state.json', CC_TEST_MODE: '1' })
  assert.equal(result.ok, true)
  assert.equal(result.testOverride, true)
})

/** Run the official gate script with a throwaway output file and a given environment. */
function runOfficialGates(env, outFile) {
  return spawnSync(process.execPath, [path.join(PROBE_ROOT, 'scripts', 'run-gates.mjs')], {
    cwd: PROBE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CC_GATE_OUT: outFile, ...env },
  })
}

await test('official: npm run gates refuses a repository-external CC_STATE_FILE (valid but wrong state)', () => {
  const dir = made('official-override-valid')
  const fake = path.join(dir, 'project_state.json')
  const fakeState = structuredClone(loadStateCheck(REPO_ROOT).state)
  fakeState.phase_00_final.gates['05_studio_readonly_tool_invoked'].status = 'BLOCKED'
  fs.writeFileSync(fake, JSON.stringify(fakeState, null, 2))

  const outFile = path.join(dir, 'final-gates.json')
  const sentinel = '{"published":"do-not-touch"}\n'
  fs.writeFileSync(outFile, sentinel)

  const run = runOfficialGates({ CC_STATE_FILE: fake }, outFile)
  assert.equal(run.status, 1, 'official gate must refuse the override, got ' + run.status + ': ' + String(run.stdout).slice(-300))
  assert.ok(
    String(run.stderr).includes('state-override-forbidden'),
    'the refusal must name its code: ' + String(run.stderr).slice(-300),
  )
  assert.equal(
    fs.readFileSync(outFile, 'utf8'),
    sentinel,
    'a refused run must not overwrite the published artifact with a refusal',
  )
})

await test('official: npm run gates refuses a repository-external CC_STATE_FILE (invalid state)', () => {
  const dir = made('official-override-invalid')
  const fake = path.join(dir, 'project_state.json')
  fs.writeFileSync(fake, '{ not json')
  const outFile = path.join(dir, 'final-gates.json')
  const run = runOfficialGates({ CC_STATE_FILE: fake }, outFile)
  assert.equal(run.status, 1, 'official gate must refuse the override, got ' + run.status)
  assert.equal(fs.existsSync(outFile), false, 'a refused run must not overwrite the published artifact')
})

await test('official: without an override the gate grades the repository state', () => {
  const dir = made('official-clean')
  const outFile = path.join(dir, 'final-gates.json')
  const run = runOfficialGates({}, outFile)
  assert.equal(run.status, 0, 'official gate should pass on the real tree: ' + String(run.stdout).slice(-400))
  const artifact = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  assert.equal(artifact.gates.state.status, 'PASS')
  assert.equal(artifact.gates.state.checked.gates, 10)
})

await test('state: a docs/review-handoff junction out of the repository is rejected', () => {
  const { root } = docEscapeFixture('doc-escape')
  const loaded = loadStateCheck(root)
  const escapes = loaded.violations.filter((v) => v.code === 'doc-escape')
  const expected = STATE_DOC_POINTERS.filter((rel) => rel.startsWith('docs/review-handoff/')).length
  assert.equal(escapes.length, expected, `every review-handoff pointer escapes: ${JSON.stringify(loaded.violations)}`)
  const result = checkProjectState(loaded)
  assert.equal(result.ok, false)
  expectCode(result, 'doc-escape')
})

await test('state: a junction that stays inside the repository still loads', () => {
  const base = made('doc-inside-link')
  const root = path.join(base, 'repo')
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs', 'real-handoff'), { recursive: true })
  fs.writeFileSync(path.join(root, 'state', 'project_state.json'), JSON.stringify({ authoritative_source: { current_record: 'phase_00_final' } }))
  fs.writeFileSync(path.join(root, 'README.md'), 'phase_00_final\n')
  fs.writeFileSync(path.join(root, 'docs', 'real-handoff', 'PHASE_00_R1_WORK_REPORT.md'), 'phase_00_final\n')
  fs.writeFileSync(path.join(root, 'docs', 'real-handoff', 'PHASE_00_REVIEW_HANDOFF.md'), 'phase_00_final\n')
  fs.symlinkSync(path.join(root, 'docs', 'real-handoff'), path.join(root, 'docs', 'review-handoff'), 'junction')
  const loaded = loadStateCheck(root)
  assert.deepEqual(loaded.violations, [], JSON.stringify(loaded.violations))
  assert.ok(loaded.docs['docs/review-handoff/PHASE_00_R1_WORK_REPORT.md'], 'document must be readable through the link')
})

/** A structurally valid gate-6 record; each test below breaks exactly one thing. */
const validGate6 = () => ({
  probe: 'CC-6-runtime-exit-code',
  gracefulClose: { exitCode: 0, exitCodeSource: 'exit-handler', afterClose: { status: 'PROCESS_ABSENT' } },
  forcedKill: { exitCode: 1, exitCodeSource: 'exit-handler', afterKill: { status: 'PROCESS_ABSENT' } },
})
const gate6Problems = (value) => EVIDENCE_CONTENT_RULES['06_runtime_exit_code_recorded'](value)

await test('gate6: a structurally valid record passes', () => {
  assert.deepEqual(gate6Problems(validGate6()), [])
})

await test('gate6: an exitCode hidden in metadata does not satisfy the gate', () => {
  const problems = gate6Problems({ metadata: { exitCode: 0 }, runtime: { processAfterClose: 'UNKNOWN' } })
  assert.ok(problems.length > 0)
  assert.ok(problems.some((p) => p.includes('gracefulClose')), JSON.stringify(problems))
})

await test('gate6: missing the forcedKill scenario fails', () => {
  const value = validGate6()
  delete value.forcedKill
  assert.ok(gate6Problems(value).some((p) => p.includes('forcedKill')))
})

await test('gate6: a string exitCode fails', () => {
  const value = validGate6()
  value.gracefulClose.exitCode = '0'
  assert.ok(gate6Problems(value).some((p) => p.includes('must be an integer')))
})

await test('gate6: a non-zero graceful exit code fails', () => {
  const value = validGate6()
  value.gracefulClose.exitCode = 2
  assert.ok(gate6Problems(value).some((p) => p.includes('must be 0')))
})

await test('gate6: a forced code equal to the graceful one fails', () => {
  const value = validGate6()
  value.forcedKill.exitCode = 0
  assert.ok(gate6Problems(value).some((p) => p.includes('must differ')))
})

await test('gate6: a missing PROCESS_ABSENT fails', () => {
  const value = validGate6()
  value.forcedKill.afterKill = { status: 'PROCESS_PRESENT' }
  assert.ok(gate6Problems(value).some((p) => p.includes('PROCESS_ABSENT')))
  const value2 = validGate6()
  delete value2.gracefulClose.afterClose
  assert.ok(gate6Problems(value2).some((p) => p.includes('PROCESS_ABSENT')))
})

await test('gate6: a CLI launcher as the source fails', () => {
  const value = validGate6()
  value.gracefulClose.exitCodeSource = 'cli-launcher'
  assert.ok(gate6Problems(value).some((p) => p.includes('launcher')))
})

await test('gate6: an unrecognised source fails', () => {
  const value = validGate6()
  value.forcedKill.exitCodeSource = 'whatever'
  assert.ok(gate6Problems(value).some((p) => p.includes('exitCodeSource')))
})

await test('gate6: the real CC-6 evidence satisfies the structured rule', () => {
  const gate = stateData().state.phase_00_final.gates['06_runtime_exit_code_recorded']
  const absolute = path.join(REPO_ROOT, gate.evidence)
  if (!fs.existsSync(absolute)) return // historical checkout without the probe evidence
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  assert.deepEqual(gate6Problems(parsed), [])
})

await test('evidence: a noExitCodeReason cannot stand in for gate 6 exit code', () => {
  const dir = made('reason-only')
  write(path.join(dir, 'only-reason.json'), JSON.stringify({ noExitCodeReason: 'SDK did not provide an exit code' }, null, 2))
  const result = checkEvidencePath(dir, 'only-reason.json', EVIDENCE_CONTENT_RULES['06_runtime_exit_code_recorded'])
  assert.equal(result.ok, false, 'a reason is not a recorded exit code')
  assert.equal(result.errors[0].code, 'gate-evidence-content')
  assert.ok(
    result.errors.some((e) => e.message.includes('noExitCodeReason')),
    JSON.stringify(result.errors),
  )
})

await test('evidence: a structured record satisfies gate 6 content rule', () => {
  const dir = made('code-only')
  write(
    path.join(dir, 'code.json'),
    JSON.stringify(
      {
        gracefulClose: { exitCode: 0, exitCodeSource: 'exit-handler', afterClose: { status: 'PROCESS_ABSENT' } },
        forcedKill: { exitCode: 1, exitCodeSource: 'exit-handler', afterKill: { status: 'PROCESS_ABSENT' } },
      },
      null,
      2,
    ),
  )
  const result = checkEvidencePath(dir, 'code.json', EVIDENCE_CONTENT_RULES['06_runtime_exit_code_recorded'])
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

await test('evidence: a string exitCode does not satisfy gate 6 content rule', () => {
  const dir = made('string-code')
  write(path.join(dir, 'string.json'), JSON.stringify({ exitCode: '0' }, null, 2))
  const result = checkEvidencePath(dir, 'string.json', EVIDENCE_CONTENT_RULES['06_runtime_exit_code_recorded'])
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'gate-evidence-content')
})

await test('state: the phase definition output files must exist', () => {
  for (const rel of REQUIRED_OUTPUT_FILES) {
    const result = checkProjectState({ state: stateData().state, docs: stateData().docs, root: REPO_ROOT })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(fs.existsSync(path.join(REPO_ROOT, rel)), true, `missing required output ${rel}`)
  }
})

await test('state: a missing state file is an error, not an empty pass', () => {
  const dir = made('no-state')
  assert.throws(() => loadStateCheck(dir), (error) => error?.code === 'ENOENT')
})

await test('exit code: the documented phrase is parsed', () => {
  assert.equal(parseExitCode('dsh profile "cc-sdk": DeepSeek Harness runtime exited\nexit code: 0'), 0)
  assert.equal(parseExitCode('dsh profile "cc-sdk": DeepSeek Harness runtime exited\nexit code: 1'), 1)
  assert.equal(parseExitCode('exit code: -2'), -2)
})

await test('exit code: a message without one yields null, never a guess', () => {
  assert.equal(parseExitCode('DeepSeek Harness runtime client is closed'), null)
  assert.equal(parseExitCode('DeepSeek Harness runtime is not running'), null)
  assert.equal(parseExitCode(''), null)
  assert.equal(parseExitCode(undefined), null)
  assert.equal(parseExitCode(42), null)
  assert.equal(parseExitCode('exit code: not-a-number'), null)
  // The phrase must be a whole line: trailing prose after the number is not a code.
  assert.equal(EXIT_CODE_PATTERN.test('exit code: 0 but not at the end of the line ok'), false)
})

// ---------------------------------------------------------------------------
// Output layer: no raw stream writes outside the single writer
// ---------------------------------------------------------------------------

await test('output: no direct stream writes outside safe-output.mjs', () => {
  const files = [
    'run-all.mjs',
    'src/lib/evidence.mjs',
    'src/lib/gates.mjs',
    'src/studio-diag.mjs',
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
      CC_TEST_MODE: '1', // the seam is honoured only in an explicit test run
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
  const published = path.join(PROBE_ROOT, 'evidence', process.env.CC_GATE_ROUND ?? 'r153', 'tests.json')
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
