#!/usr/bin/env node
/**
 * Builds the isolated DSH profiles the probes need, from nothing.
 *
 * PHASE 00-R1 review finding: the probes assumed `cc-sdk` / `cc-cli` already existed
 * on the author's machine, and the commandcode plugin was never declared anywhere in
 * the repository. A reader who cloned the repo and ran `node run-all.mjs` could not
 * reproduce the run.
 *
 * This script makes the environment a build artefact:
 *
 *   isolated DSH_HOME
 *     ├── profiles/cc-sdk   dsh-base + dsh-sdk-app        + commandcode plugin
 *     └── profiles/cc-cli   dsh-base + dsh-headless       + commandcode plugin
 *   patches/               the two ordered patch files the probes pass to the runtime
 *
 * It is idempotent: existing profiles are kept, a missing plugin is reinstalled.
 * It never writes to the user's own `~/.dsh`, never upgrades the global `dsh`, and
 * never reads or stores a credential value — only the environment variable NAME is
 * referenced by the generated patch.
 *
 * Usage:
 *   node scripts/setup-profiles.mjs [--home <dir>] [--json]
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { probeRoot } from '../src/lib/paths.mjs'

const PLUGIN = '@mars-sea/dsh-commandcode-provider'
const PLUGIN_VERSION = process.env.CC_PLUGIN_VERSION ?? '0.15.4'
const CREDENTIAL_ENV = 'COMMANDCODE_API_KEY'
const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'

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

function parseArgs(argv) {
  const args = { home: process.env.CC_DSH_HOME ?? path.join(probeRoot, 'dsh-home'), json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = path.resolve(argv[++i])
    else if (argv[i] === '--json') args.json = true
  }
  return args
}

function profilePackageJson(name, bundles) {
  return {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { [PLUGIN]: PLUGIN_VERSION },
    dsh: { profile: { bundles, patchReload: 'startup' } },
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Install the plugin into a profile's own node_modules (no global side effects).
 *
 * An existing install is only accepted when the version matches exactly — a profile
 * left over from an older run must not silently satisfy the requirement.
 */
function ensurePlugin(profileDir, log) {
  const installed = path.join(profileDir, 'node_modules', ...PLUGIN.split('/'), 'package.json')
  const expected = PLUGIN_VERSION

  if (fs.existsSync(installed)) {
    const version = JSON.parse(fs.readFileSync(installed, 'utf8')).version
    if (version === expected) {
      log({ step: 'plugin.verified', profile: path.basename(profileDir), version })
      return { installed: true, version, reinstalled: false, versionVerified: true }
    }
    log({ step: 'plugin.version_mismatch', profile: path.basename(profileDir), found: version, expected })
  } else {
    log({ step: 'plugin.install', profile: path.basename(profileDir), spec: `${PLUGIN}@${expected}` })
  }

  // Windows cannot exec a .cmd shim without a shell; `shell: true` also keeps the
  // command portable to POSIX where npm is a plain executable.
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts', `${PLUGIN}@${expected}`], {
    cwd: profileDir,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: true,
  })
  const version = JSON.parse(fs.readFileSync(installed, 'utf8')).version
  if (version !== expected) {
    throw new Error(`installed ${PLUGIN}@${version}, expected ${expected}`)
  }
  log({ step: 'plugin.installed', profile: path.basename(profileDir), version })
  return { installed: true, version, reinstalled: true, versionVerified: true }
}

/**
 * Fingerprint the plugin's resolved dependency tree.
 *
 * `npm install` without a committed lockfile can resolve transitive dependencies
 * differently over time. The plugin's own version being pinned does not pin its tree,
 * so the resolved set is recorded to a lock snapshot under profile-locks/ and compared
 * on later runs; a drift is reported instead of passing silently.
 */
function dependencySnapshot(profileDir, lockDirectory, profileName, log) {
  let listed = null
  try {
    const raw = execFileSync('npm', ['ls', '--all', '--json', '--depth=8'], {
      cwd: profileDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      shell: true,
    })
    listed = JSON.parse(raw)
  } catch (error) {
    // `npm ls` exits non-zero on peer problems while still printing the tree.
    const partial = String(error?.stdout ?? '')
    try {
      listed = JSON.parse(partial)
    } catch {
      log({ step: 'deps.snapshot_failed', profile: profileName })
      return { fingerprint: null, packages: [], drift: null, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  const packages = []
  const walk = (node) => {
    for (const [name, dep] of Object.entries(node?.dependencies ?? {})) {
      if (dep && dep.version) packages.push(`${name}@${dep.version}`)
      walk(dep)
    }
  }
  walk(listed)
  packages.sort()
  const fingerprint = packages.length
    ? `sha256:${crypto.createHash('sha256').update(packages.join('\n')).digest('hex').slice(0, 16)}`
    : null

  fs.mkdirSync(lockDirectory, { recursive: true })
  const lockPath = path.join(lockDirectory, `${profileName}.deps.json`)
  const recorded = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null
  const drift = recorded && recorded.fingerprint && fingerprint && recorded.fingerprint !== fingerprint
    ? { previous: recorded.fingerprint, current: fingerprint }
    : null

  if (!recorded) {
    fs.writeFileSync(lockPath, `${JSON.stringify({ plugin: `${PLUGIN}@${PLUGIN_VERSION}`, fingerprint, packages }, null, 2)}\n`)
    log({ step: 'deps.lock_created', profile: profileName, fingerprint, count: packages.length })
  } else if (drift) {
    log({ step: 'deps.drift_detected', profile: profileName, ...drift })
  } else {
    log({ step: 'deps.lock_matches', profile: profileName, fingerprint })
  }

  return { fingerprint, packages, drift, lockPath }
}

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

/** Build every profile and patch, returning a machine-readable summary. */
export function setupProfiles({ home = path.join(probeRoot, 'dsh-home'), patchDirectory = path.join(probeRoot, 'tmp'), log = () => {} } = {}) {
  fs.mkdirSync(home, { recursive: true })
  const profiles = []
  for (const spec of PROFILES) {
    const dir = path.join(home, 'profiles', spec.name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      writeJson(path.join(dir, 'package.json'), profilePackageJson(spec.name, spec.bundles))
      log({ step: 'profile.created', profile: spec.name, bundles: spec.bundles })
    } else {
      const current = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const defined = current?.dsh?.profile?.bundles ?? []
      const sameBundles = defined.length === spec.bundles.length && spec.bundles.every((b) => defined.includes(b))
      if (!sameBundles) {
        log({ step: 'profile.redefined', profile: spec.name, was: defined, now: spec.bundles })
        writeJson(path.join(dir, 'package.json'), profilePackageJson(spec.name, spec.bundles))
      } else {
        log({ step: 'profile.verified', profile: spec.name })
      }
    }
    const plugin = ensurePlugin(dir, log)
    const deps = dependencySnapshot(dir, path.join(probeRoot, 'profile-locks'), spec.name, log)
    profiles.push({ name: spec.name, label: spec.label, dir, bundles: spec.bundles, plugin, deps })
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
    credential: { envName: CREDENTIAL_ENV, present: credentialPresent },
  }
}

if (process.argv[1] && process.argv[1].endsWith('setup-profiles.mjs')) {
  const args = parseArgs(process.argv.slice(2))
  const log = args.json ? () => {} : (event) => process.stdout.write(`[setup] ${JSON.stringify(event)}\n`)
  const summary = setupProfiles({ home: args.home, patchDirectory: path.join(probeRoot, 'tmp'), log })
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else {
    process.stdout.write(`\n[setup] DSH home  : ${summary.home}\n`)
    for (const p of summary.profiles) process.stdout.write(`[setup] profile   : ${p.name} (plugin ${p.plugin.version})\n`)
    process.stdout.write(`[setup] provider  : ${summary.provider} / ${summary.model}\n`)
    process.stdout.write(`[setup] credential: ${summary.credential.envName} present=${summary.credential.present}\n`)
    if (!summary.credential.present) {
      process.stdout.write(`[setup] WARNING: ${summary.credential.envName} is not set; model probes will report BLOCKED.\n`)
    }
  }
}
