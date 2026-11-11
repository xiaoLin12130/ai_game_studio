/**
 * Studio configuration: one JSON file under the OS user-data directory.
 *
 * Two rules the rest of PHASE 01-A depends on:
 *  - defaults always exist, so a first launch needs no file;
 *  - a file that cannot be parsed is moved aside, never silently overwritten, and the
 *    recovery is reported to the UI instead of being swallowed.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface StudioConfig {
  version: number
  dsh: {
    /** Explicit dsh entry; null means "use the one bundled with the official SDK". */
    entryPath: string | null
    /** Named DSH profile the runtime boots with. */
    profile: string
    /** Isolated DSH home; null means "<userData>/dsh-home". */
    dshHome: string | null
    /** Route used only for the handshake; the probe never sends a prompt. */
    provider: string
    model: string
    /** Upper bound for a whole probe, in milliseconds. */
    probeTimeoutMs: number
  }
  ui: {
    autoProbeOnStart: boolean
  }
}

export const CONFIG_VERSION = 1

export const DEFAULT_CONFIG: StudioConfig = {
  version: CONFIG_VERSION,
  dsh: {
    entryPath: null,
    profile: 'sdk',
    dshHome: null,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    probeTimeoutMs: 60000,
  },
  ui: {
    autoProbeOnStart: true,
  },
}

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 300000

export interface ConfigLoadResult {
  config: StudioConfig
  recovered: boolean
  note: string | null
  path: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

/**
 * Merge user input over the defaults and report what had to be replaced.
 *
 * Unknown keys are dropped on purpose: the file is a contract, not a scratch pad.
 */
export function validateConfig(input: unknown): { config: StudioConfig; problems: string[] } {
  const problems: string[] = []
  const config: StudioConfig = {
    version: CONFIG_VERSION,
    dsh: { ...DEFAULT_CONFIG.dsh },
    ui: { ...DEFAULT_CONFIG.ui },
  }
  if (!isPlainObject(input)) {
    problems.push('config is not a JSON object; defaults applied')
    return { config, problems }
  }

  if (input.version !== CONFIG_VERSION) {
    if (input.version !== undefined) problems.push(`unknown config version ${String(input.version)}; defaults applied`)
  }

  const dsh = isPlainObject(input.dsh) ? input.dsh : {}
  if (input.dsh !== undefined && !isPlainObject(input.dsh)) problems.push('dsh must be an object')

  const entryPath = dsh.entryPath
  if (entryPath === null || entryPath === undefined) {
    config.dsh.entryPath = null
  } else if (nonEmptyString(entryPath)) {
    config.dsh.entryPath = nonEmptyString(entryPath)
  } else {
    problems.push('dsh.entryPath must be a non-empty string or null')
  }

  const profile = nonEmptyString(dsh.profile)
  if (profile) config.dsh.profile = profile
  else if (dsh.profile !== undefined) problems.push('dsh.profile must be a non-empty string')

  const home = dsh.dshHome
  if (home === null || home === undefined) config.dsh.dshHome = null
  else if (nonEmptyString(home)) config.dsh.dshHome = nonEmptyString(home)
  else problems.push('dsh.dshHome must be a non-empty string or null')

  const provider = nonEmptyString(dsh.provider)
  if (provider) config.dsh.provider = provider
  else if (dsh.provider !== undefined) problems.push('dsh.provider must be a non-empty string')

  const model = nonEmptyString(dsh.model)
  if (model) config.dsh.model = model
  else if (dsh.model !== undefined) problems.push('dsh.model must be a non-empty string')

  if (dsh.probeTimeoutMs !== undefined) {
    const value = dsh.probeTimeoutMs
    if (typeof value === 'number' && Number.isFinite(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS) {
      config.dsh.probeTimeoutMs = Math.round(value)
    } else {
      problems.push(`dsh.probeTimeoutMs must be a number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
    }
  }

  const ui = isPlainObject(input.ui) ? input.ui : {}
  if (input.ui !== undefined && !isPlainObject(input.ui)) problems.push('ui must be an object')
  if (typeof ui.autoProbeOnStart === 'boolean') config.ui.autoProbeOnStart = ui.autoProbeOnStart
  else if (ui.autoProbeOnStart !== undefined) problems.push('ui.autoProbeOnStart must be a boolean')

  return { config, problems }
}

export const configFilePath = (userDataDir: string): string => path.join(userDataDir, 'config.json')

/**
 * Read the config, repairing what can be repaired.
 *
 * A broken file is renamed rather than deleted so the user can inspect it; the returned
 * `recovered` flag is what the UI shows, so "your settings were reset" is never silent.
 */
export function loadConfig(userDataDir: string, now = new Date()): ConfigLoadResult {
  const file = configFilePath(userDataDir)
  if (!fs.existsSync(file)) {
    return { config: { ...DEFAULT_CONFIG, dsh: { ...DEFAULT_CONFIG.dsh }, ui: { ...DEFAULT_CONFIG.ui } }, recovered: false, note: null, path: file }
  }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const note = `config could not be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'}); defaults applied`
    return { config: structuredClone(DEFAULT_CONFIG), recovered: true, note, path: file }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const backup = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
    let note = 'config.json was not valid JSON; defaults applied'
    try {
      fs.renameSync(file, backup)
      note = `config.json was not valid JSON; moved to ${path.basename(backup)} and defaults applied`
    } catch {
      note = 'config.json was not valid JSON; defaults applied (the broken file could not be moved aside)'
    }
    return { config: structuredClone(DEFAULT_CONFIG), recovered: true, note, path: file }
  }
  const { config, problems } = validateConfig(parsed)
  return {
    config,
    recovered: problems.length > 0,
    note: problems.length > 0 ? problems.join('; ') : null,
    path: file,
  }
}

export function saveConfig(userDataDir: string, config: StudioConfig): string {
  const file = configFilePath(userDataDir)
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return file
}
