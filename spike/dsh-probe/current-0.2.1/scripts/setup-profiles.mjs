#!/usr/bin/env node
/**
 * Builds and verifies the isolated DSH profiles the probes need.
 *
 * History matters here, because each round found the previous check too shallow:
 *   R1.1  created the profiles from nothing (a fresh clone could not reproduce the run);
 *   R1.2  recorded a version-list fingerprint, which is not a lockfile;
 *   R1.3  added a real npm lockfile and made drift abort the run.
 *
 * R1.4 closes the remaining holes:
 *   - the lockfile is required. A normal run never generates one; only `--update-lock`
 *     does, and that is a deliberate maintenance action;
 *   - the installed tree is fingerprinted. Version equality alone lets a modified
 *     `node_modules` pass, so file hashes are compared against `tree.json`;
 *   - the profile's own package.json is compared field by field, not just bundles;
 *   - the plugin's declared DSH compatibility range is checked against the runtime;
 *   - any mismatch is repaired deterministically from the lockfile, and a mismatch that
 *     survives the repair is a hard failure.
 *
 * Layout it produces:
 *
 *   <DSH_HOME>/profiles/cc-sdk   dsh-base + dsh-sdk-app   + commandcode plugin
 *   <DSH_HOME>/profiles/cc-cli   dsh-base + dsh-headless  + commandcode plugin
 *   tmp/                         the ordered patch files the probes pass to the runtime
 *
 * It never writes to the user's own `~/.dsh`, never upgrades the global `dsh`, and
 * never reads or stores a credential value — only the variable NAME appears in a patch.
 *
 * Usage:
 *   node scripts/setup-profiles.mjs [--home <dir>] [--json]
 *   node scripts/setup-profiles.mjs --update-lock     # maintenance only
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { probeRoot } from '../src/lib/paths.mjs'
import { out, err, jsonOut } from '../src/lib/safe-output.mjs'

const PLUGIN = '@mars-sea/dsh-commandcode-provider'
const PLUGIN_VERSION = process.env.CC_PLUGIN_VERSION ?? '0.15.4'
const CREDENTIAL_ENV = 'COMMANDCODE_API_KEY'
const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'
/**
 * Lockfiles live in the repository by default. `CC_LOCK_ROOT` exists so the regression
 * tests can delete or corrupt a lock in a copy and observe the failure, without ever
 * touching the real baseline. Nothing else should set it.
 */
const lockRootDir = () =>
  process.env.CC_LOCK_ROOT ? path.resolve(process.env.CC_LOCK_ROOT) : path.join(probeRoot, 'profile-locks')

/** Profile definitions mirror the user's real desktop profile, minus its UI plugins. */
const PROFILES = [
  {
    name: 'cc-sdk',
    label: 'SDK JSON-RPC profile used by every SDK probe',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  },
  {
    name: 'cc-cli',
    label: 'One-shot CLI profile used for the baseline prompt',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  },
]

/**
 * A dependency state that does not match the baseline.
 *
 * Fatal by design: the suite must never report PASS while running on dependencies the
 * lockfile does not describe.
 */
export class DependencyError extends Error {
  constructor(code, message, detail = null) {
    super(message)
    this.name = 'DependencyError'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// version helpers — only the range shapes this plugin actually uses
// ---------------------------------------------------------------------------

function parseVersion(value) {
  const [main, pre] = String(value).split('-', 2)
  const nums = main.split('.').map((n) => Number.parseInt(n, 10) || 0)
  return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ?? null }
}

/** Semver-ish comparison, including prerelease ordering. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const lhs = left.pre.split('.')
  const rhs = right.pre.split('.')
  for (let i = 0; i < Math.max(lhs.length, rhs.length); i += 1) {
    if (lhs[i] === undefined) return -1
    if (rhs[i] === undefined) return 1
    const ln = Number.parseInt(lhs[i], 10)
    const rn = Number.parseInt(rhs[i], 10)
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) {
      if (ln !== rn) return ln < rn ? -1 : 1
    } else if (lhs[i] !== rhs[i]) {
      return lhs[i] < rhs[i] ? -1 : 1
    }
  }
  return 0
}

/**
 * Evaluate a simple `>=A <B` range.
 *
 * Returns `null` for anything it does not understand rather than guessing. `^0.2.1`
 * used to fall through to an equality comparison against the literal string, which
 * produced "false" — a wrong answer that looks like a verdict. A range that cannot be
 * evaluated must surface as UNKNOWN.
 */
export function satisfiesRange(version, range) {
  const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  if (!VERSION.test(String(version))) return null
  const parts = String(range).trim().split(/\s+/)
  if (parts.length === 0) return null
  for (const part of parts) {
    const m = part.match(/^(>=|>|<=|<|=)?(.+)$/)
    if (!m) return null
    const op = m[1] ?? '='
    if (!['>=', '>', '<=', '<', '='].includes(op)) return null
    if (!VERSION.test(m[2])) return null
    const cmp = compareVersions(version, m[2])
    const ok =
      op === '>='
        ? cmp >= 0
        : op === '>'
          ? cmp > 0
          : op === '<='
            ? cmp <= 0
            : op === '<'
              ? cmp < 0
              : cmp === 0
    if (!ok) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

/** Recursive copy, by hand: `fs.cpSync` is terminated by this host's safe-delete shim. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else if (entry.isSymbolicLink()) {
      fs.rmSync(dst, { force: true })
      fs.symlinkSync(fs.readlinkSync(src), dst)
    } else fs.copyFileSync(src, dst)
  }
}

/**
 * Content fingerprint of a directory tree.
 *
 * Paths and bytes, sorted, hashed. This turns "the version is right" into "the
 * installed files are the ones the lockfile produced".
 */
export function treeDigest(dir) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) {
        files.push(`${rel}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(dir, '')
  files.sort()
  return {
    count: files.length,
    sha256: crypto.createHash('sha256').update(files.join('\n')).digest('hex'),
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Read JSON that is part of the dependency baseline.
 *
 * A malformed baseline file is a dependency failure with a code, not an uncaught
 * SyntaxError: the suite has to report it the same way it reports a version mismatch.
 */
function readJsonOrError(file, name, code) {
  try {
    return readJson(file)
  } catch (error) {
    throw new DependencyError(code, `${path.basename(file)} for ${name} cannot be parsed`, {
      message: String(error?.message ?? error).slice(0, 160),
    })
  }
}

function displayPath(target) {
  const rel = path.relative(probeRoot, target)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `<probe>/${rel.split(path.sep).join('/')}`
  }
  return `<external>/${path.basename(target)}`
}

function profilePackageJson(name, bundles) {
  return {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { [PLUGIN]: PLUGIN_VERSION },
    dsh: { profile: { bundles, patchReload: 'startup' } },
  }
}

// ---------------------------------------------------------------------------
// lockfile
// ---------------------------------------------------------------------------

function lockPaths(name) {
  const dir = path.join(lockRootDir(), name)
  return {
    dir,
    manifest: path.join(dir, 'package.json'),
    lock: path.join(dir, 'package-lock.json'),
    tree: path.join(dir, 'tree.json'),
  }
}

const lockEntry = (lock) => lock?.packages?.[`node_modules/${PLUGIN}`]

/** Blocking sleep, so the retry does not need to make this function async. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run npm, converting a child failure into a dependency error with a code.
 *
 * One retry: on Windows a just-exited npm process can still hold handles on the staging
 * `node_modules`, and the first attempt fails with EBUSY. That is transient, and a gate
 * that fails randomly gets ignored — so retry once with a short pause, then give up.
 */
function runNpm(args, cwd, code, attempts = 2) {
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return execFileSync('npm', args, { cwd, stdio: 'pipe', encoding: 'utf8', shell: true })
    } catch (error) {
      last = error
      if (attempt < attempts) sleepSync(600)
    }
  }
  // The tail is redacted downstream by the single output layer, but keep it short:
  // npm prints the working directory, which is machine-specific.
  throw new DependencyError(code, 'npm command failed', {
    command: `npm ${args[0]}`,
    status: last?.status ?? null,
    stderrTail: String(last?.stderr ?? '').slice(-240),
  })
}

/**
 * Install from the lockfile in a staging directory and fingerprint the result.
 *
 * The staged tree is reused when it already matches the lockfile: `npm ci` is the slow
 * and flaky part, and there is nothing to gain from repeating it to produce bytes we
 * already have. When it does not match, the install is repeated deterministically and
 * the result must match the lockfile exactly.
 */
function stageInstall(name, paths, lock, log) {
  const staging = path.join(probeRoot, 'tmp', `.stage-${name}`)
  const pluginDir = path.join(staging, 'node_modules', ...PLUGIN.split('/'))

  if (lock?.tree && fs.existsSync(pluginDir)) {
    const cached = treeDigest(pluginDir)
    if (cached.sha256 === lock.tree.sha256 && cached.count === lock.tree.files) {
      log({ step: 'stage.reused', profile: name, files: cached.count })
      return { pluginDir, ...cached }
    }
  }

  fs.mkdirSync(staging, { recursive: true })
  fs.copyFileSync(paths.manifest, path.join(staging, 'package.json'))
  fs.copyFileSync(paths.lock, path.join(staging, 'package-lock.json'))
  runNpm(['ci', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts'], staging, 'install-failed')

  if (!fs.existsSync(pluginDir)) {
    throw new DependencyError('install-empty', `npm ci produced no ${PLUGIN} for ${name}`)
  }
  const digest = treeDigest(pluginDir)
  if (lock?.tree && (digest.sha256 !== lock.tree.sha256 || digest.count !== lock.tree.files)) {
    throw new DependencyError('stage-mismatch', `npm ci did not reproduce the locked tree for ${name}`, {
      files: digest.count,
      expectedFiles: lock.tree.files,
    })
  }
  log({ step: 'stage.installed', profile: name, files: digest.count })
  return { pluginDir, ...digest }
}

/**
 * Generate the lockfile and tree fingerprint. Maintenance action only.
 *
 * Called from `--update-lock`; a normal run that finds a missing lockfile fails.
 */
function regenerateLock(name, log) {
  const paths = lockPaths(name)
  writeJson(paths.manifest, {
    name: `cc-profile-lock-${name}`,
    private: true,
    dependencies: { [PLUGIN]: PLUGIN_VERSION },
  })
  runNpm(
    ['install', '--package-lock-only', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts'],
    paths.dir,
    'lock-generate-failed',
  )
  const lock = readJson(paths.lock)
  const entry = lockEntry(lock)
  if (!entry?.version) throw new DependencyError('lock-invalid', `lockfile for ${name} has no entry for ${PLUGIN}`)

  const staged = stageInstall(name, paths, null, log)
  const tree = {
    plugin: PLUGIN,
    version: entry.version,
    integrity: entry.integrity ?? null,
    resolved: entry.resolved ?? null,
    files: staged.count,
    sha256: staged.sha256,
    generatedBy: 'scripts/setup-profiles.mjs --update-lock',
  }
  writeJson(paths.tree, tree)
  log({ step: 'lock.updated', profile: name, version: entry.version, files: staged.count })
  return { ...paths, entry, tree }
}

/** Load and validate the lockfile. Missing is fatal outside maintenance mode. */
function loadLock(name, { regenerate = false, log = () => {} } = {}) {
  const paths = lockPaths(name)
  // Maintenance mode is a full re-baseline: it must not be blocked by the very
  // consistency checks it is about to satisfy.
  if (regenerate) return regenerateLock(name, log)

  const missingFiles = [paths.manifest, paths.lock, paths.tree].filter((file) => !fs.existsSync(file))

  if (missingFiles.length) {
    throw new DependencyError(
      'lock-missing',
      `dependency lock for ${name} is incomplete; run with --update-lock to regenerate it`,
      { missing: missingFiles.map(displayPath) },
    )
  }
  // A normal run never regenerates a lock. See the `regenerate` early return above.

  const declared = readJsonOrError(paths.manifest, name, 'lock-manifest-invalid')?.dependencies?.[PLUGIN]
  if (declared !== PLUGIN_VERSION) {
    throw new DependencyError(
      'lock-manifest-mismatch',
      `profile-locks/${name}/package.json declares ${declared ?? 'nothing'} but ${PLUGIN_VERSION} is required`,
      { declared: declared ?? null, expected: PLUGIN_VERSION },
    )
  }

  const lock = readJsonOrError(paths.lock, name, 'lock-invalid')
  const entry = lockEntry(lock)
  if (!entry?.version || !entry?.integrity || !entry?.resolved) {
    throw new DependencyError('lock-invalid', `lockfile for ${name} is missing version/integrity/resolved`, {
      hasVersion: Boolean(entry?.version),
      hasIntegrity: Boolean(entry?.integrity),
      hasResolved: Boolean(entry?.resolved),
    })
  }
  if (entry.version !== PLUGIN_VERSION) {
    throw new DependencyError(
      'lock-version-mismatch',
      `lockfile pins ${PLUGIN}@${entry.version} but ${PLUGIN_VERSION} is required`,
      { locked: entry.version, expected: PLUGIN_VERSION },
    )
  }

  const tree = readJsonOrError(paths.tree, name, 'tree-metadata-invalid')
  if (tree.version !== entry.version) {
    throw new DependencyError('tree-metadata-mismatch', `tree.json for ${name} describes a different version`, {
      tree: tree.version,
      lock: entry.version,
    })
  }
  // R1.4.1: presence of these fields is not the same as agreement with the baseline.
  // A re-resolved tarball (or a tampered lockfile) changes integrity/resolved while
  // leaving the version string alone; that must fail rather than silently reusing a
  // cached staging tree.
  if (!tree.integrity || tree.integrity !== entry.integrity) {
    throw new DependencyError(
      'tree-integrity-mismatch',
      `tree.json integrity for ${name} does not match package-lock.json`,
      { tree: tree.integrity ?? null, lock: entry.integrity },
    )
  }
  if (!tree.resolved || tree.resolved !== entry.resolved) {
    throw new DependencyError(
      'tree-resolved-mismatch',
      `tree.json resolved for ${name} does not match package-lock.json`,
      { tree: tree.resolved ?? null, lock: entry.resolved },
    )
  }

  log({ step: 'lock.verified', profile: name, version: entry.version, integrity: 'matches', resolved: 'matches' })
  return { ...paths, entry, tree }
}

// ---------------------------------------------------------------------------
// profile + install
// ---------------------------------------------------------------------------

/** Create or repair the profile manifest, and record whether it matched. */
function ensureProfile(home, name, bundles, log) {
  const dir = path.join(home, 'profiles', name)
  const manifestPath = path.join(dir, 'package.json')
  const expected = profilePackageJson(name, bundles)

  if (!fs.existsSync(manifestPath)) {
    writeJson(manifestPath, expected)
    log({ step: 'profile.created', profile: name, bundles })
    return { dir, repaired: true, reason: 'missing' }
  }

  const current = readJson(manifestPath)
  const problems = []
  if (current?.dependencies?.[PLUGIN] !== expected.dependencies[PLUGIN]) {
    problems.push(`dependencies.${PLUGIN}=${current?.dependencies?.[PLUGIN] ?? 'absent'}`)
  }
  const actualBundles = current?.dsh?.profile?.bundles ?? []
  const sameBundles =
    actualBundles.length === bundles.length && bundles.every((bundle) => actualBundles.includes(bundle))
  if (!sameBundles) problems.push(`bundles=${JSON.stringify(actualBundles)}`)

  if (problems.length === 0) {
    log({ step: 'profile.verified', profile: name })
    return { dir, repaired: false, reason: null }
  }

  // Repair is safe and deterministic: the manifest is ours to own, and the expected
  // content is a constant in this file.
  writeJson(manifestPath, expected)
  log({ step: 'profile.repaired', profile: name, problems })
  return { dir, repaired: true, reason: problems.join('; ') }
}

/** Copy the staged package into the profile, replacing whatever is there. */
function installFromStage(profileDir, staged, name, log) {
  const target = path.join(profileDir, 'node_modules', ...PLUGIN.split('/'))
  copyTree(staged.pluginDir, target)
  log({ step: 'plugin.installed', profile: name, version: PLUGIN_VERSION })
}

/** Verify the installed tree against the lockfile's fingerprint. */
function verifyInstalled(profileDir, lock, name) {
  const pluginDir = path.join(profileDir, 'node_modules', ...PLUGIN.split('/'))
  const manifestPath = path.join(pluginDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, code: 'install-missing', detail: { profile: name } }
  }

  let version
  try {
    version = readJson(manifestPath).version
  } catch (error) {
    // A manifest that cannot be parsed is a broken install, not a crash: fall through to
    // the deterministic repair instead of letting a SyntaxError escape.
    return {
      ok: false,
      code: 'install-manifest-invalid',
      detail: { profile: name, message: String(error?.message ?? error).slice(0, 120) },
    }
  }

  if (version !== lock.entry.version) {
    return {
      ok: false,
      code: 'install-version',
      detail: { profile: name, installed: version, locked: lock.entry.version },
    }
  }
  const digest = treeDigest(pluginDir)
  if (digest.sha256 !== lock.tree.sha256 || digest.count !== lock.tree.files) {
    return {
      ok: false,
      code: 'install-tree',
      detail: { profile: name, files: digest.count, expectedFiles: lock.tree.files },
    }
  }
  return { ok: true, version, files: digest.count }
}

/**
 * The plugin declares which DSH line it runs on; check it against the installed SDK.
 *
 * The manifest is read from the verified profile install, and the runtime version from
 * the probe's own `node_modules` — the exact pair the probes will use. If either side
 * is missing the answer is UNKNOWN, never COMPATIBLE.
 */
function checkRuntimeCompatibility(pluginDir) {
  const pluginManifest = path.join(pluginDir, 'package.json')
  const dshManifest = path.join(probeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!fs.existsSync(pluginManifest)) return { status: 'UNKNOWN', reason: 'plugin manifest not found in profile' }
  if (!fs.existsSync(dshManifest)) return { status: 'UNKNOWN', reason: 'dsh package not found in probe workspace' }

  const range = readJson(pluginManifest)?.engines?.dsh ?? null
  const version = readJson(dshManifest).version
  if (!range) return { status: 'UNKNOWN', reason: 'plugin declares no dsh engine range', dsh: version }
  const satisfied = satisfiesRange(version, range)
  if (satisfied === null) return { status: 'UNKNOWN', reason: `range not evaluated: ${range}`, dsh: version }
  return { status: satisfied ? 'COMPATIBLE' : 'INCOMPATIBLE', dsh: version, range }
}

// ---------------------------------------------------------------------------
// patches
// ---------------------------------------------------------------------------

/**
 * Patch files.
 *
 * `insert:` adds rows; a bare `id:` overrides an existing row. Registering the
 * provider alone is not enough for a CLI run: the default model must also be
 * pointed at it, otherwise the runtime silently keeps using another provider.
 */
function writePatches(patchDirectory) {
  fs.mkdirSync(patchDirectory, { recursive: true })
  const providerOnly = [
    '# Generated by scripts/setup-profiles.mjs',
    '# Registers the user-supplied commandcode route. apiKeyEnv is a NAME, never a value.',
    '- insert:',
    '    - id: llm-commandcode',
    `      name: '${PLUGIN}'`,
    '      config:',
    `        apiKeyEnv: ${CREDENTIAL_ENV}`,
    '',
  ].join('\n')

  const cliPatch = [
    '# Generated by scripts/setup-profiles.mjs',
    '# CLI runs need the default model overridden too: registering a route does not',
    '# change which provider the agent actually uses.',
    '- insert:',
    '    - id: llm-commandcode',
    `      name: '${PLUGIN}'`,
    '      config:',
    `        apiKeyEnv: ${CREDENTIAL_ENV}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${PROVIDER}`,
    `    model: ${MODEL}`,
    '    reasoningEffort: high',
    '',
  ].join('\n')

  const files = {
    providerPatch: path.join(patchDirectory, 'cc-provider.cordis.yml'),
    cliPatch: path.join(patchDirectory, 'cc-cli.patch.yml'),
  }
  fs.writeFileSync(files.providerPatch, providerOnly)
  fs.writeFileSync(files.cliPatch, cliPatch)
  return files
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Build every profile and patch, returning a machine-readable summary.
 *
 * Throws `DependencyError` when the environment cannot be proven consistent.
 */
export function setupProfiles({
  home = process.env.CC_DSH_HOME ?? path.join(probeRoot, 'dsh-home'),
  patchDirectory = path.join(probeRoot, 'tmp'),
  log = () => {},
  updateLock: regenerate = false,
} = {}) {
  fs.mkdirSync(home, { recursive: true })

  const profiles = []
  for (const spec of PROFILES) {
    const profile = ensureProfile(home, spec.name, spec.bundles, log)
    const lock = loadLock(spec.name, { regenerate, log })

    let verification = verifyInstalled(profile.dir, lock, spec.name)
    if (!verification.ok) {
      // Deterministic repair from the lockfile, then re-verify. A second failure is
      // fatal: it means the lockfile and the install cannot agree.
      log({ step: 'install.repair', profile: spec.name, reason: verification.code })
      const staged = stageInstall(spec.name, lockPaths(spec.name), lock, log)
      installFromStage(profile.dir, staged, spec.name, log)
      verification = verifyInstalled(profile.dir, lock, spec.name)
      if (!verification.ok) {
        throw new DependencyError(
          verification.code,
          `installed tree for ${spec.name} still does not match the lockfile after repair`,
          verification.detail,
        )
      }
      log({ step: 'install.repaired', profile: spec.name })
    }

    profiles.push({
      name: spec.name,
      label: spec.label,
      dir: profile.dir,
      bundles: spec.bundles,
      profileRepaired: profile.repaired,
      pluginDir: path.join(profile.dir, 'node_modules', ...PLUGIN.split('/')),
      plugin: { installed: true, version: verification.version, files: verification.files },
      lock: {
        file: `profile-locks/${spec.name}/package-lock.json`,
        version: lock.entry.version,
        integrity: lock.entry.integrity,
        resolved: lock.entry.resolved,
      },
    })
  }

  const runtime = checkRuntimeCompatibility(profiles[0].pluginDir)
  if (runtime.status === 'INCOMPATIBLE') {
    throw new DependencyError(
      'runtime-incompatible',
      `${PLUGIN}@${PLUGIN_VERSION} does not support dsh ${runtime.dsh}`,
      runtime,
    )
  }

  const patches = writePatches(patchDirectory)
  const credentialPresent = Boolean(process.env[CREDENTIAL_ENV])

  return {
    ok: true,
    home,
    profiles,
    patches,
    plugin: { name: PLUGIN, version: PLUGIN_VERSION },
    provider: PROVIDER,
    model: MODEL,
    runtime,
    credential: { envName: CREDENTIAL_ENV, present: credentialPresent },
  }
}

if (process.argv[1] && process.argv[1].endsWith('setup-profiles.mjs')) {
  const args = { home: process.env.CC_DSH_HOME ?? path.join(probeRoot, 'dsh-home'), json: false, updateLock: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = path.resolve(argv[++i])
    else if (argv[i] === '--json') args.json = true
    else if (argv[i] === '--update-lock') args.updateLock = true
  }

  const log = args.json ? () => {} : (event) => out(`[setup] ${JSON.stringify(event)}\n`)
  let summary
  try {
    summary = setupProfiles({
      home: args.home,
      patchDirectory: path.join(probeRoot, 'tmp'),
      log,
      updateLock: args.updateLock,
    })
  } catch (error) {
    err(`[setup] FAILED ${error.name}${error.code ? ` (${error.code})` : ''}: ${error.message}\n`)
    if (error.detail) err(`[setup] detail ${JSON.stringify(error.detail)}\n`)
    process.exit(1)
  }

  if (args.json) {
    jsonOut(summary)
  } else {
    out(`\n[setup] DSH home  : ${displayPath(summary.home)}\n`)
    for (const item of summary.profiles) {
      out(
        `[setup] profile   : ${item.name} (plugin ${item.plugin.version}, ${item.plugin.files} files, lock ${item.lock.file})\n`,
      )
    }
    out(`[setup] runtime   : ${summary.runtime.status}${summary.runtime.dsh ? ` (dsh ${summary.runtime.dsh})` : ''}\n`)
    out(`[setup] credential: ${summary.credential.envName} present=${summary.credential.present}\n`)
    if (!summary.credential.present) {
      out(`[setup] WARNING: ${summary.credential.envName} is not set; model probes will report BLOCKED.\n`)
    }
  }
}
