/**
 * Where the DSH runtime used for the probe comes from.
 *
 * The default is the runtime bundled with the official SDK dependency: the SDK resolves
 * and version-checks it itself, so Studio never guesses a path. An explicit path is
 * honoured only when the user sets one, and a configured path that does not exist is
 * reported as a problem instead of being silently ignored.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const requireFromHere = createRequire(__filename)

export interface DshEntry {
  kind: 'configured' | 'bundled' | 'unknown'
  /** Path passed to the SDK as `dshBin`, or null to let the SDK resolve its own. */
  bin: string | null
  /** Human-readable path shown in diagnostics. */
  displayPath: string | null
  version: string | null
  problem: string | null
}

/** Read `version` from the nearest package.json above `entry`. */
function versionFromPackage(entryPath: string): string | null {
  let dir = path.dirname(entryPath)
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(dir, 'package.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (parsed.version) return parsed.version
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Find the bundled `@deepseek-ai/dsh` entry and its version without spawning anything.
 *
 * The dsh package is a CLI, so its manifest has no "." export: resolving the package name
 * throws "No \"exports\" main defined". The manifest subpath is exported, and `bin.dsh`
 * names the actual entry.
 */
export function bundledDsh(): { entry: string | null; version: string | null; problem: string | null } {
  try {
    const manifestPath = requireFromHere.resolve('@deepseek-ai/dsh/package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      version?: string
      bin?: string | Record<string, string>
    }
    const binField = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (!binField) {
      return { entry: null, version: manifest.version ?? null, problem: 'the dsh package manifest has no bin.dsh entry' }
    }
    const entry = path.resolve(path.dirname(manifestPath), binField)
    if (!fs.existsSync(entry)) {
      return { entry: null, version: manifest.version ?? null, problem: `the dsh CLI entry is missing: ${entry}` }
    }
    return { entry, version: manifest.version ?? null, problem: null }
  } catch (error) {
    return {
      entry: null,
      version: null,
      problem: `the official SDK dependency is missing its dsh runtime: ${(error as Error)?.message ?? String(error)}`,
    }
  }
}

export function resolveDshEntry(configuredPath: string | null | undefined): DshEntry {
  if (configuredPath && configuredPath.trim().length > 0) {
    const absolute = path.resolve(configuredPath.trim())
    if (!fs.existsSync(absolute)) {
      return { kind: 'configured', bin: absolute, displayPath: absolute, version: null, problem: 'the configured dsh entry does not exist' }
    }
    return { kind: 'configured', bin: absolute, displayPath: absolute, version: versionFromPackage(absolute), problem: null }
  }

  const bundled = bundledDsh()
  if (!bundled.entry) {
    return { kind: 'unknown', bin: null, displayPath: null, version: null, problem: bundled.problem }
  }
  return { kind: 'bundled', bin: null, displayPath: bundled.entry, version: bundled.version, problem: null }
}
