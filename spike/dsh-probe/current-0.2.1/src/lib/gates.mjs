/**
 * Overall verdict and exit code for the suite, plus the PHASE 00 state gate.
 *
 * `decideOverall` was extracted from `run-all.mjs` so the claim "a leak fails the
 * run" is provable without running six model probes. `checkProjectState` was added
 * for the same reason, one level up: the project had three different documents each
 * declaring a different object in project_state.json as the authoritative one, and
 * two of those objects still said the two core PHASE 00 gates were BLOCKED. A report
 * that says PASS while the declared source of truth says BLOCKED is not a handoff.
 *
 * The gate only reads files that are already published. It cannot repair anything,
 * and it deliberately refuses an incomplete document set rather than quietly passing.
 *
 * PHASE 00 convergence hardened the gate against three ways of passing without being
 * right, which the first version accepted:
 *
 *   1. `Object.keys(gates).length === 10` — delete a real scope gate, add a made-up one,
 *      keep the count at ten, and the check passed. The required ids are now named.
 *   2. `docs` counted instead of matched — four unrelated documents with the right
 *      phrase in them stood in for the four documents that must point at the record.
 *   3. `fs.existsSync` — an empty file, a directory, a truncated JSON blob and a path
 *      that escapes the repository all "existed". Each is now rejected on its own.
 */
import fs from 'node:fs'
import path from 'node:path'

export const EXIT = { PASS: 0, BLOCKED: 2, FAIL: 1 }

/**
 * The ten PHASE 00 scope gates, verbatim from
 * `phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` ("验收门禁", in order).
 *
 * The ids are part of the contract, not a naming convenience: a gate that can be
 * swapped for another gate of the same count is not a gate.
 */
export const REQUIRED_GATE_IDS = [
  '01_environment_inventory',
  '02_sdk_version_compatibility',
  '03_real_prompt_trackable_result',
  '04_events_visible',
  '05_studio_readonly_tool_invoked',
  '06_runtime_exit_code_recorded',
  '07_session_resume_approval_classified',
  '08_tech_selection_adr',
  '09_no_secrets_in_git_or_logs',
  '10_github_push_and_review_handoff',
]

/** Documents that must point at the single current record. */
export const STATE_DOC_POINTERS = [
  'docs/phase-reports/PHASE_00_REPORT.md',
  'docs/phase-reports/PHASE_00_EVIDENCE.md',
  'docs/phase-reports/PHASE_00_R1_EVIDENCE.md',
  'docs/review-handoff/PHASE_00_R1_WORK_REPORT.md',
  'docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md',
  'docs/review-handoff/PHASE_00_WORK_REPORT.md',
  'README.md',
  'memory-bank/handoff.md',
]

/**
 * Files the phase definition itself requires as this phase's output
 * (`phases/PHASE_00_FEASIBILITY_DSH_VERTICAL_SLICE.md` → "本阶段输出").
 *
 * Checked in addition to the pointer documents, never instead of them.
 */
export const REQUIRED_OUTPUT_FILES = [
  'docs/phase-reports/PHASE_00_REPORT.md',
  'docs/phase-reports/PHASE_00_EVIDENCE.md',
  'docs/decisions/ADR-0001-tech-stack.md',
  'docs/decisions/ADR-0002-dsh-integration.md',
  'docs/review-handoff/PHASE_00_REVIEW_HANDOFF.md',
]

/** A phrase that declares one of the historical gate sets to be current. */
const STALE_POINTER = /phase_00(?:_r1)?\.gate_results[^\n]{0,60}(?:为准|唯一权威|唯一当前|当前权威)/

/** Historical round records that must survive; deleting them would erase evidence. */
const HISTORICAL_RECORDS = ['r11', 'r12', 'r13', 'r14', 'r141']

/** Verdict values the schema allows. */
const ALLOWED_VERDICTS = ['PASS', 'PARTIALLY_VERIFIED', 'BLOCKED', 'FAIL']

/**
 * @param {object} input
 * @param {number} [input.failed]      probes that returned FAIL
 * @param {number} [input.blocked]     probes that returned BLOCKED
 * @param {'PASS'|'FAIL'} [input.dependency] dependency gate status
 * @param {'PASS'|'FAIL'} [input.leak]       leak gate status
 * @param {'PASS'|'FAIL'} [input.state]      project-state gate status
 */
export function decideOverall({ failed = 0, blocked = 0, dependency = 'PASS', leak = 'PASS', state = 'PASS' } = {}) {
  const gateFailures = [dependency, leak, state].filter((s) => s === 'FAIL').length
  const overall = failed + gateFailures > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS'
  return { overall, exitCode: EXIT[overall], gateFailures }
}

/**
 * Is `rel` a path that stays inside `root`?
 *
 * `path.resolve` collapses `..`, so the comparison happens after resolution — a
 * string prefix test on the raw input would let `docs/../../secrets.json` through.
 *
 * @param {string} root absolute repository root
 * @param {string} rel repository-relative path from the state file
 * @returns {boolean}
 */
export function staysInside(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false
  const resolved = path.resolve(root, rel)
  const normalRoot = path.resolve(root)
  if (resolved === normalRoot) return false
  return resolved.startsWith(normalRoot + path.sep)
}

/** Real path, following symlinks and Windows junctions; `null` when nothing exists there. */
function realpathOrNull(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target)
  } catch {
    try {
      return fs.realpathSync(target)
    } catch {
      return null
    }
  }
}

/** Is `child` strictly below `parent`? Compares with `path.relative`, which is case-folding on win32. */
export function isInsideDirectory(parent, child) {
  const relative = path.relative(parent, child)
  if (relative === '') return false
  if (path.isAbsolute(relative)) return false
  return relative.split(path.sep)[0] !== '..'
}

/**
 * Resolve where a repository-relative path *actually* lands on disk.
 *
 * The lexical check alone was not enough, and review was right: `path.resolve` never
 * looks at the filesystem, so `evidence/link/secret.json` passes it even when `link` is
 * a junction pointing outside the repository — `fs.statSync` and `fs.readFileSync` then
 * happily follow the link. On Windows that needs no privileges at all: junctions are
 * creatable by any user, directory symlinks are not.
 *
 * Resolution strategy:
 *   1. reject lexically (`..`, absolute paths) before touching the filesystem;
 *   2. walk up to the deepest path that really exists and `realpath` that ancestor —
 *      this covers a symlinked/junctioned component in the middle of the path;
 *   3. re-append the non-existent tail and compare against the `realpath` of the root.
 *
 * @param {string} root absolute repository root
 * @param {string} rel repository-relative path taken from the state file
 * @returns {{ok: boolean, code: string|null, real: string|null, realRoot: string|null, message: string|null}}
 */
export function resolveContainedRealPath(root, rel) {
  if (!staysInside(root, rel)) {
    return {
      ok: false,
      code: 'gate-evidence-escape',
      real: null,
      realRoot: null,
      message: `path escapes the repository root: ${rel}`,
    }
  }

  const lexical = path.resolve(root, rel)
  const realRoot = realpathOrNull(path.resolve(root)) ?? path.resolve(root)

  let probe = lexical
  const tail = []
  let realAncestor = null
  while (true) {
    realAncestor = realpathOrNull(probe)
    if (realAncestor !== null) break
    const parent = path.dirname(probe)
    if (parent === probe) break
    tail.unshift(path.basename(probe))
    probe = parent
  }
  if (realAncestor === null) {
    return {
      ok: false,
      code: 'gate-evidence-escape',
      real: null,
      realRoot,
      message: `no existing ancestor could be resolved for: ${rel}`,
    }
  }

  const real = tail.length === 0 ? realAncestor : path.join(realAncestor, ...tail)
  if (!isInsideDirectory(realRoot, real)) {
    return {
      ok: false,
      code: 'gate-evidence-escape',
      real,
      realRoot,
      message: `resolved path leaves the repository root: ${rel} -> ${real}`,
    }
  }
  return { ok: true, code: null, real, realRoot, message: null }
}

/**
 * Facts an evidence file must actually contain, per gate.
 *
 * "The file exists and parses" was still not enough for gate 6: `cc-3-resume/summary.json`
 * is valid JSON and did not contain any exit code, yet the state claimed gate 6 was met on
 * it. A gate whose whole point is a specific measured value has to assert that value.
 *
 * A rule returns an array of human-readable problems; empty means satisfied.
 */
/**
 * Where an exit code legitimately comes from: the SDK's own exit event on the child it
 * spawned, surfaced through the documented `TransportClosedError` message. A CLI
 * launcher's code is a different process and is never acceptable evidence here.
 */
export const SDK_EXIT_CODE_SOURCES = ['exit-handler', 'post-close-subscribe', 'transport-closed-error']

/** Values that claim a launcher's exit code instead of the managed runtime's. */
const LAUNCHER_SOURCE = /launcher|\bcli\b|shell-run|spawnSync|execFile/i

export const EVIDENCE_CONTENT_RULES = {
  /**
   * Gate 6 demands structure, not a lucky match.
   *
   * Recursively searching for any integer `exitCode` made the rule pass on
   * `{"metadata":{"exitCode":0},"runtime":{"processAfterClose":"UNKNOWN"}}` — a file that
   * records nothing about a shutdown. The gate now reads the two scenarios it claims to
   * have measured, and rejects a code that is not attributed to the SDK-managed process.
   */
  '06_runtime_exit_code_recorded': (value) => {
    const problems = []
    const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    if (record === null) return ['gate 6 evidence must be a JSON object with a gracefulClose and a forcedKill scenario']

    const scenarios = [
      ['gracefulClose', 'afterClose'],
      ['forcedKill', 'afterKill'],
    ]
    for (const [scenarioKey, processKey] of scenarios) {
      const scenario = record[scenarioKey]
      if (scenario === null || typeof scenario !== 'object') {
        problems.push(`${scenarioKey} scenario is missing from the evidence`)
        continue
      }
      if (!Number.isInteger(scenario.exitCode)) {
        problems.push(`${scenarioKey}.exitCode must be an integer, got ${JSON.stringify(scenario.exitCode ?? null)}`)
      }
      const status = scenario[processKey]?.status
      if (status !== 'PROCESS_ABSENT') {
        problems.push(`${scenarioKey}.${processKey}.status must be PROCESS_ABSENT, got ${JSON.stringify(status ?? null)}`)
      }
      const source = String(scenario.exitCodeSource ?? '')
      if (LAUNCHER_SOURCE.test(source)) {
        problems.push(`${scenarioKey}.exitCodeSource names a CLI launcher ("${source}"), not the SDK-managed runtime`)
      } else if (!SDK_EXIT_CODE_SOURCES.includes(source)) {
        problems.push(
          `${scenarioKey}.exitCodeSource must be one of ${SDK_EXIT_CODE_SOURCES.join(' / ')}, got ${JSON.stringify(source)}`,
        )
      }
    }

    const graceful = record.gracefulClose?.exitCode
    const forced = record.forcedKill?.exitCode
    if (Number.isInteger(graceful) && graceful !== 0) {
      problems.push(`gracefulClose.exitCode must be 0 for a normal shutdown, got ${graceful}`)
    }
    if (Number.isInteger(graceful) && Number.isInteger(forced) && forced === graceful) {
      problems.push('forcedKill.exitCode must differ from gracefulClose.exitCode, otherwise the number is not being measured')
    }

    if (String(record.noExitCodeReason ?? '').trim().length > 0) {
      problems.push('a noExitCodeReason explains a missing code; it cannot accompany a gate-6 PASS')
    }
    return problems.map((problem) => problem.replace(/^gate 6 /, ''))
  },
}

/**
 * Verify one evidence path: it exists, it is a regular file, it is not empty, and its
 * content parses for the type its extension promises.
 *
 * Markdown and other text evidence is not parsed as JSON; it only has to be a non-empty
 * regular file. Parsing is applied where the file claims to be machine-readable, which
 * is exactly where a truncated record would otherwise pass as "the file exists".
 *
 * @param {string} root absolute repository root
 * @param {string} rel path as written in the state file
 * @param {((value: unknown) => string[]) | null} [contentRule] per-gate assertion about the parsed value
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, kind: string|null}}
 */
export function checkEvidencePath(root, rel, contentRule = null) {
  const errors = []
  const fail = (code, message) => errors.push({ code, message })

  if (typeof rel !== 'string' || rel.trim().length === 0) {
    return { ok: false, errors: [{ code: 'gate-no-evidence', message: 'evidence path is empty' }], kind: null }
  }
  const contained = resolveContainedRealPath(root, rel)
  if (!contained.ok) {
    return {
      ok: false,
      errors: [{ code: contained.code ?? 'gate-evidence-escape', message: contained.message ?? `evidence escapes the repository root: ${rel}` }],
      kind: null,
    }
  }

  // Read through the resolved real path: the lexical one was only a claim about spelling.
  const absolute = contained.real
  const extension = path.extname(path.resolve(root, rel)).toLowerCase()

  let stat
  try {
    stat = fs.statSync(absolute)
  } catch {
    return {
      ok: false,
      errors: [{ code: 'gate-evidence-missing', message: `evidence does not exist: ${rel}` }],
      kind: extension || null,
    }
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      errors: [{ code: 'gate-evidence-not-file', message: `evidence is not a regular file: ${rel}` }],
      kind: extension || null,
    }
  }
  if (stat.size === 0) {
    return {
      ok: false,
      errors: [{ code: 'gate-evidence-empty', message: `evidence is empty: ${rel}` }],
      kind: extension || null,
    }
  }

  let text
  try {
    text = fs.readFileSync(absolute, 'utf8')
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: 'gate-evidence-unreadable', message: `evidence cannot be read: ${rel} (${error?.code ?? 'error'})` }],
      kind: extension || null,
    }
  }
  if (text.trim().length === 0) {
    return {
      ok: false,
      errors: [{ code: 'gate-evidence-empty', message: `evidence has no content: ${rel}` }],
      kind: extension || null,
    }
  }

  if (extension === '.json') {
    try {
      const value = JSON.parse(text)
      if (typeof contentRule === 'function') {
        for (const problem of contentRule(value) ?? []) fail('gate-evidence-content', `${rel}: ${problem}`)
      }
    } catch (error) {
      fail('gate-evidence-unparsable', `evidence is not valid JSON: ${rel} (${String(error?.message ?? error).slice(0, 120)})`)
    }
  } else if (extension === '.jsonl') {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length === 0) {
      fail('gate-evidence-empty', `evidence has no records: ${rel}`)
    }
    const records = []
    for (const [index, line] of lines.entries()) {
      try {
        records.push(JSON.parse(line))
      } catch (error) {
        fail(
          'gate-evidence-unparsable',
          `evidence line ${index + 1} is not valid JSON: ${rel} (${String(error?.message ?? error).slice(0, 120)})`,
        )
        break
      }
    }
    if (typeof contentRule === 'function' && records.length === lines.length) {
      for (const problem of contentRule(records) ?? []) fail('gate-evidence-content', `${rel}: ${problem}`)
    }
  }

  return { ok: errors.length === 0, errors, kind: extension || null }
}

/**
 * Read the state file and the pointer documents from a repository root.
 * Separate from the check so tests can inject a mutated state object.
 *
 * A missing or unreadable pointer document is left out of `docs` on purpose: the
 * caller then reports `doc-set-incomplete` naming the file, instead of the whole gate
 * dying on an ENOENT with no useful message.
 */
export function loadStateCheck(root, stateFile = null) {
  const violations = []

  // The evidence check was hardened first while the state inputs were not, which review
  // caught: `state/` or `docs/review-handoff/` can be a junction pointing outside the
  // repository, and the plain read here would follow it. The same containment rule now
  // guards the two inputs that decide what the gates even get to look at.
  let file
  if (stateFile === null) {
    const contained = resolveContainedRealPath(root, 'state/project_state.json')
    if (!contained.ok) {
      violations.push({
        code: 'state-escape',
        message: `the state file must live inside the repository: ${contained.message ?? 'state/project_state.json'}`,
      })
      file = path.resolve(root, 'state', 'project_state.json')
    } else {
      file = contained.real
    }
  } else {
    // `CC_STATE_FILE` is a test/operator seam: the regression suite injects a mutated copy
    // outside the repository. It is resolved for links but not confined to the root — an
    // attacker who can set this process's environment does not need this seam.
    file = realpathOrNull(path.resolve(stateFile)) ?? path.resolve(stateFile)
  }

  const state = JSON.parse(fs.readFileSync(file, 'utf8'))

  const docs = {}
  for (const rel of STATE_DOC_POINTERS) {
    const contained = resolveContainedRealPath(root, rel)
    if (!contained.ok) {
      violations.push({
        code: 'doc-escape',
        message: `pointer document must live inside the repository: ${contained.message ?? rel}`,
      })
      continue // left out of docs as well, so doc-set-incomplete names it
    }
    try {
      docs[rel] = fs.readFileSync(contained.real, 'utf8')
    } catch {
      /* left out so checkProjectState can name the missing document */
    }
  }
  return { state, docs, root, violations }
}

/**
 * Verify that the project has exactly one current state record, that it is complete,
 * that history is preserved, and that no published document points at a stale record.
 *
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, checked: object}}
 */
export function checkProjectState({ state, docs = {}, root = null, violations = [] }) {
  const errors = []
  const fail = (code, message) => errors.push({ code, message })
  const checked = { gates: 0, deferred: 0, unknown: 0, docs: 0, evidence: 0 }

  // Containment failures found while loading are part of the verdict, not a side note.
  for (const violation of Array.isArray(violations) ? violations : []) {
    fail(violation?.code ?? 'load-violation', violation?.message ?? 'state input failed containment')
  }

  if (!state || typeof state !== 'object') {
    return { ok: false, errors: [{ code: 'state-unreadable', message: 'project_state.json is not an object' }], checked }
  }

  // 1. One declared source of truth, and it is the final record.
  if (state.authoritative_source?.current_record !== 'phase_00_final') {
    fail('authority-missing', 'authoritative_source.current_record must be phase_00_final')
  }

  const final = state.phase_00_final
  if (!final || typeof final !== 'object') {
    return { ok: false, errors: [...errors, { code: 'current-record-missing', message: 'phase_00_final is missing' }], checked }
  }

  // 2. Top-level fields must agree with the current record.
  if (!ALLOWED_VERDICTS.includes(final.verdict)) fail('verdict-invalid', `unsupported verdict ${final.verdict}`)
  if (state.current_phase !== 'PHASE_00') fail('top-level-phase', 'current_phase must be PHASE_00')
  if (state.product_status !== final.product_status) fail('top-level-status', 'product_status disagrees with phase_00_final.product_status')
  if (state.phase_status?.PHASE_00 !== final.verdict) fail('top-level-verdict', 'phase_status.PHASE_00 disagrees with phase_00_final.verdict')

  // 3. The ten PHASE 00 scope gates, by id: all PASS, each with a valid evidence file.
  const gates = final.gates ?? {}
  const gateIds = Object.keys(gates)
  checked.gates = gateIds.length
  for (const id of REQUIRED_GATE_IDS) {
    if (!Object.prototype.hasOwnProperty.call(gates, id)) fail('gate-id-missing', `required PHASE 00 gate is missing: ${id}`)
  }
  for (const id of gateIds) {
    if (!REQUIRED_GATE_IDS.includes(id)) fail('gate-id-unknown', `gate id is not in the PHASE 00 scope: ${id}`)
  }
  for (const [id, gate] of Object.entries(gates)) {
    if (gate?.status !== 'PASS') fail('gate-not-pass', `${id} status is ${gate?.status ?? 'missing'}`)
    if (!gate?.evidence) {
      fail('gate-no-evidence', `${id} has no evidence path`)
    } else if (root) {
      const evidence = checkEvidencePath(root, gate.evidence, EVIDENCE_CONTENT_RULES[id] ?? null)
      checked.evidence += 1
      for (const problem of evidence.errors) fail(problem.code, `${id} ${problem.message}`)
    }
  }

  // 3b. A PASS verdict has to be earned: the label may not outrun the gates.
  if (typeof final.verdict_reason !== 'string' || final.verdict_reason.trim().length === 0) {
    fail('verdict-no-reason', 'phase_00_final.verdict_reason must explain the verdict')
  }
  if (final.verdict === 'PASS') {
    const notPassing = REQUIRED_GATE_IDS.filter((id) => final.gates?.[id]?.status !== 'PASS')
    if (notPassing.length > 0) {
      fail('verdict-overclaimed', `verdict is PASS but these gates are not: ${notPassing.join(', ')}`)
    }
    if (Array.isArray(final.blocking_items) && final.blocking_items.length > 0) {
      fail('verdict-overclaimed', 'verdict is PASS but blocking_items is not empty')
    }
  }

  // 4. Every deferred item has a phase, a risk and a verification condition.
  const deferred = final.deferred ?? {}
  checked.deferred = Object.keys(deferred).length
  if (checked.deferred < 8) fail('deferred-count', `expected at least 8 deferred items, found ${checked.deferred}`)
  for (const [id, item] of Object.entries(deferred)) {
    for (const key of ['status', 'phase', 'risk', 'verify_when']) {
      if (!item?.[key]) fail('deferred-incomplete', `${id} is missing ${key}`)
    }
    if (item?.status === 'CONFIRMED' || item?.status === 'PASS') {
      fail('deferred-overclaimed', `${id} is deferred but marked ${item.status}`)
    }
  }

  // 5. UNKNOWN items must say why they are unknown and what would resolve them.
  const unknown = final.unknown ?? {}
  checked.unknown = Object.keys(unknown).length
  if (checked.unknown < 1) fail('unknown-count', 'no UNKNOWN items recorded')
  for (const [id, item] of Object.entries(unknown)) {
    for (const key of ['why_unknown', 'condition_to_verify']) {
      if (!item?.[key]) fail('unknown-incomplete', `${id} is missing ${key}`)
    }
    if (item?.status !== 'UNKNOWN') fail('unknown-status', `${id} status must be UNKNOWN`)
  }

  // 6. HY4 via WorkBuddy is not proof that DSH can call HY4. Never CONFIRMED, never blocking.
  const hy4 = final.independent_verification?.hy4_dsh_direct
  if (!hy4) {
    fail('hy4-missing', 'independent_verification.hy4_dsh_direct is missing')
  } else {
    if (hy4.status !== 'UNKNOWN') fail('hy4-status', `HY4 direct status must be UNKNOWN, got ${hy4.status}`)
    if (hy4.blocking !== false) fail('hy4-blocking', 'HY4 direct must not block PHASE 00')
    if (!/WorkBuddy/.test(String(hy4.note ?? ''))) fail('hy4-note', 'HY4 note must separate WorkBuddy use from DSH direct support')
  }

  // 7. Historical evidence must be preserved, not overwritten by the new record.
  if (!state.phase_00 || !state.phase_00_r1) fail('history-lost', 'phase_00 / phase_00_r1 records are missing')
  for (const key of HISTORICAL_RECORDS) {
    if (!state.phase_00_r1?.[key]) fail('history-lost', `phase_00_r1.${key} is missing`)
  }

  // 8. The document set is the named set, not a set of the right size.
  const docEntries = Object.entries(docs)
  checked.docs = docEntries.length
  for (const rel of STATE_DOC_POINTERS) {
    if (!Object.prototype.hasOwnProperty.call(docs, rel)) {
      fail('doc-set-incomplete', `required pointer document is missing: ${rel}`)
    }
  }
  for (const [rel, text] of docEntries) {
    if (!String(text).includes('phase_00_final')) fail('doc-pointer-missing', `${rel} does not point at phase_00_final`)
    if (STALE_POINTER.test(String(text))) fail('doc-stale-pointer', `${rel} declares a historical gate_results as current`)
    if (String(text).trim().length === 0) fail('doc-empty', `${rel} is empty`)
  }

  // 9. The phase definition's own output files must exist, in addition to the pointers.
  if (root) {
    for (const rel of REQUIRED_OUTPUT_FILES) {
      const absolute = path.resolve(root, rel)
      let stat = null
      try {
        stat = fs.statSync(absolute)
      } catch {
        fail('phase-output-missing', `required phase output is missing: ${rel}`)
        continue
      }
      if (!stat.isFile()) fail('phase-output-missing', `required phase output is not a file: ${rel}`)
      else if (stat.size === 0) fail('phase-output-missing', `required phase output is empty: ${rel}`)
    }
  }

  return { ok: errors.length === 0, errors, checked }
}
