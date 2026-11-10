#!/usr/bin/env node
/**
 * Builds the isolated DSH profiles the probes need, from nothing.
 *
 * PHASE 00-R1 review finding: the probes assumed `cc-sdk` / `cc-cli` already existed
 * on the author's machine, and the commandcode plugin was never declared anywhere in
 * the repository. A reader who cloned the repo and ran `node run-all.mjs` could not
 * reproduce the run.
 *
 * R1.3 review finding: the previous version recorded a version-list fingerprint, which
 * is not a lockfile — it could not reproduce an install, and a drift only produced a
 * log line instead of failing the run. This version uses a real npm lockfile:
 *
 *   profile-locks/<profile>/package.json        the plugin, pinned
 *   profile-locks/<profile>/package-lock.json   resolved tree + integrity (committed)
 *
 * Installation runs `npm ci` from that lockfile in a staging directory and copies the
 * resolved package into the profile, so the tree is whatever the lock says — not
 * whatever the registry happens to serve today. Any mismatch between the lock, the
 * resolved install and the profile's installed version is a hard failure, not a log
 * line.
 *
 * Layout it produces:
 *
 *   <DSH_HOME>
 *     ├── profiles/cc-sdk   dsh-base + dsh-sdk-app        + commandcode plugin
 *     └── profiles/cc-cli   dsh-base + dsh-headless       + commandcode plugin
 *   tmp/                    the two ordered patch files the probes pass to the runtime
 *
 * It is idempotent. It never writes to the user's own `~/.dsh`, never upgrades the
 * global `dsh`, and never reads or stores a credential value — only the environment
 * variable NAME is referenced by the generated patch.
 *
 * Usage:
 *   node scripts/setup-profiles.mjs [--home <dir>] [--json]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { probeRoot } from '../src/lib/paths.mjs'
import { redact } from '../src/lib/evidence.mjs'

const PLUGIN = '@mars-sea/dsh-commandcode-provider'
const PLUGIN_VERSION = process.env.CC_PLUGIN_VERSION ?? '0.15.4'
const CREDENTIAL_ENV = 'COMMANDCODE_API_KEY'
const PROVIDER = process.env.CC_PROVIDER ?? 'commandcode'
const MODEL = process.env.CC_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const LOCK_ROOT = path.join(probeRoot, 'profile-locks')

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

/** Raised when the committed lock and the installed tree disagree. Fatal by design. */
class DependencyDriftError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'DependencyDriftError'
    this.detail = detail
  }
}

function parseArgs(argv) {
  const args = { home: process.env.CC_DSH_HOME ?? path.join(probeRoot, 'dsh-home'), json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = path.resolve(argv[++i])
    else if (argv[i] === '--json') args.json = true
  }
  return args
}

/** Repo-relative display form, so console output never carries an absolute path. */
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Ensure `profile-locks/<name>/` holds a real npm lockfile for this plugin.
 *
 * The plugin declares no `dependencies` — only peer ranges that the profile bundles
 * already satisfy — so its installable tree really is a single package. That is why
 * the lockfile is one entry; it is still a genuine `npm ci` input, which the old
 * hand-rolled fingerprint never was.
 */
function ensureLock(name, log) {
  const dir = path.join(LOCK_ROOT, name)
  const manifestPath = path.join(dir, 'package.json')
  const lockPath = path.join(dir, 'package-lock.json')
  const manifest = {
    name: `cc-profile-lock-${name}`,
    private: true,
    dependencies: { [PLUGIN]: PLUGIN_VERSION },
  }

  const manifestStale =
    !fs.existsSync(manifestPath) || readJson(manifestPath)?.dependencies?.[PLUGIN] !== PLUGIN_VERSION
  if (manifestStale) {
    writeJson(manifestPath, manifest)
  }

  if (!fs.existsSync(lockPath) || manifestStale) {
    execFileSync(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts'],
      { cwd: dir, stdio: 'pipe', encoding: 'utf8', shell: true },
    )
    log({ step: 'lock.created', profile: name, file: `profile-locks/${name}/package-lock.json` })
  }

  const lock = readJson(lockPath)
  const entry = lock?.packages?.[`node_modules/${PLUGIN}`]
  if (!entry?.version) {
    throw new DependencyDriftError(`lockfile for ${name} has no entry for ${PLUGIN}`, { name })
  }
  if (entry.version !== PLUGIN_VERSION) {
    throw new DependencyDriftError(
      `lockfile pins ${PLUGIN}@${entry.version} but ${PLUGIN_VERSION} is required`,
      { profile: name, locked: entry.version, expected: PLUGIN_VERSION },
    )
  }
  log({ step: 'lock.verified', profile: name, version: entry.version, integrity: entry.integrity ? 'present' : 'absent' })
  return { dir, manifestPath, lockPath, version: entry.version, integrity: entry.integrity ?? null }
}

/**
 * Recursive copy, by hand.
 *
 * `fs.cpSync` terminates this process on the authoring host (exit 127, no message) —
 * the injected safe-delete shim intercepts it. A plain readdir/copyFile walk is fine,
 * and being explicit also makes symlink handling visible instead of implicit.
 */
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
 * Install the plugin from the lockfile into a profile's own node_modules.
 *
 * `npm ci` runs in a staging directory (it insists on owning the tree), then the one
 * resolved package is copied into the profile. Copying rather than installing keeps the
 * profile's own package.json — which dsh writes and owns — untouched.
 *
 * The staging directory is reused rather than deleted: `npm ci` clears its own
 * node_modules, and a recursive delete from this process would be another bulk delete.
 */
function installFromLock(profileDir, lockInfo, name, log) {
  const staging = path.join(probeRoot, 'tmp', `.stage-${name}`)
  fs.mkdirSync(staging, { recursive: true })
  fs.copyFileSync(lockInfo.manifestPath, path.join(staging, 'package.json'))
  fs.copyFileSync(lockInfo.lockPath, path.join(staging, 'package-lock.json'))

  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts'], {
    cwd: staging,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: true,
  })

  const source = path.join(staging, 'node_modules', ...PLUGIN.split('/'))
  if (!fs.existsSync(source)) {
    throw new DependencyDriftError(`npm ci produced no ${PLUGIN} in the staging tree`, { profile: name })
  }

  const target = path.join(profileDir, 'node_modules', ...PLUGIN.split('/'))
  copyTree(source, target)
  log({ step: 'plugin.installed_from_lock', profile: name, version: PLUGIN_VERSION })
}

/**
 * Ensure the profile carries exactly the locked plugin version.
 *
 * An existing install is accepted only when the version matches the lock. Anything
 * else is reinstalled from the lock and re-checked; a mismatch after reinstall is
 * fatal, because it would mean the suite ran on an unverified dependency.
 */
function ensurePlugin(profileDir, lockInfo, name, log) {
  const installedManifest = path.join(profileDir, 'node_modules', ...PLUGIN.split('/'), 'package.json')
  if (fs.existsSync(installedManifest)) {
    const version = readJson(installedManifest).version
    if (version === lockInfo.version) {
      log({ step: 'plugin.verified', profile: name, version })
      return { installed: true, version, reinstalled: false, versionVerified: true }
    }
    log({ step: 'plugin.version_mismatch', profile: name, found: version, expected: lockInfo.version })
  } else {
    log({ step: 'plugin.install', profile: name, spec: `${PLUGIN}@${lockInfo.version}` })
  }

  installFromLock(profileDir, lockInfo, name, log)

  const version = readJson(installedManifest).version
  if (version !== lockInfo.version) {
    throw new DependencyDriftError(
      `installed ${PLUGIN}@${version} does not match lockfile ${lockInfo.version}`,
      { profile: name, installed: version, locked: lockInfo.version },
    )
  }
  log({ step: 'plugin.installed', profile: name, version })
  return { installed: true, version, reinstalled: true, versionVerified: true }
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
      const current = readJson(path.join(dir, 'package.json'))
      const defined = current?.dsh?.profile?.bundles ?? []
      const sameBundles = defined.length === spec.bundles.length && spec.bundles.every((b) => defined.includes(b))
      if (!sameBundles) {
        log({ step: 'profile.redefined', profile: spec.name, was: defined, now: spec.bundles })
        writeJson(path.join(dir, 'package.json'), profilePackageJson(spec.name, spec.bundles))
      } else {
        log({ step: 'profile.verified', profile: spec.name })
      }
    }
    const lock = ensureLock(spec.name, log)
    const plugin = ensurePlugin(dir, lock, spec.name, log)
    profiles.push({ name: spec.name, label: spec.label, dir, bundles: spec.bundles, plugin, lock: { file: `profile-locks/${spec.name}/package-lock.json`, version: lock.version, integrity: lock.integrity } })
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
  const log = args.json ? () => {} : (event) => process.stdout.write(`[setup] ${JSON.stringify(redact(event))}\n`)
  let summary
  try {
    summary = setupProfiles({ home: args.home, patchDirectory: path.join(probeRoot, 'tmp'), log })
  } catch (error) {
    // A drift is a gate failure, not a warning: say so with a non-zero exit.
    process.stderr.write(`[setup] FAILED ${error.name}: ${redact(String(error.message))}\n`)
    if (error.detail) process.stderr.write(`[setup] detail ${JSON.stringify(redact(error.detail))}\n`)
    process.exit(1)
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(redact(summary), null, 2)}\n`)
  } else {
    process.stdout.write(`\n[setup] DSH home  : ${displayPath(summary.home)}\n`)
    for (const p of summary.profiles) {
      process.stdout.write(`[setup] profile   : ${p.name} (plugin ${p.plugin.version}, lock ${p.lock.file})\n`)
    }
    process.stdout.write(`[setup] provider  : ${summary.provider} / ${summary.model}\n`)
    process.stdout.write(`[setup] credential: ${summary.credential.envName} present=${summary.credential.present}\n`)
    if (!summary.credential.present) {
      process.stdout.write(`[setup] WARNING: ${summary.credential.envName} is not set; model probes will report BLOCKED.\n`)
    }
  }
}
