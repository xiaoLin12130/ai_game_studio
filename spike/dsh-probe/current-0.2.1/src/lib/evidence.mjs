/**
 * Evidence logging helpers for the PHASE 00 DSH probe.
 * Every probe appends structured records to a JSONL file so the report can cite
 * machine-checkable facts instead of prose.
 *
 * The evidence is published in a public repository, so every record passes through
 * `redact()`: local user directories, the hostname and the repository root are
 * replaced with placeholders. Nothing here removes facts that matter to a reviewer
 * — only machine-specific prefixes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const HOME_DIR = os.homedir()
const HOSTNAME = os.hostname()

/**
 * Absolute path patterns.
 *
 * Prefix substitution alone is not enough: a process command line comes back from the
 * OS in the console code page, so a path containing non-ASCII characters arrives
 * mojibake'd and no longer matches the Unicode repository root. Matching on the
 * drive-letter shape instead catches it regardless of encoding.
 */
const WINDOWS_ABS = /(?<![A-Za-z0-9])[A-Za-z]:\\[^\s"',;)]*/g
const WINDOWS_ABS_FWD = /(?<![A-Za-z0-9])[A-Za-z]:\/[^\s"',;)]*/g
/**
 * A drive path with at least one nested separator.
 *
 * Needed because a value sometimes stores an escaped newline literally, so the
 * character before the drive letter is the letter `n` of `\n` and every boundary-based
 * pattern above fails on it. Requiring a second separator excludes the false positive
 * `note:\n` while still catching `F:\workbuddy\resources\...`.
 */
const WINDOWS_ABS_NESTED = /[A-Za-z]:\\[^\s"',;)]*\\[^\s"',;)]*/g
const POSIX_HOME_ABS = /(?:\/(?:Users|home|mnt|opt|private|var|tmp))\/[^\s"',;)]*/g

/** Collapse any absolute path to one placeholder. */
export function scrubPaths(text) {
  return text
    .replace(WINDOWS_ABS, '<abs-path>')
    .replace(WINDOWS_ABS_FWD, '<abs-path>')
    .replace(WINDOWS_ABS_NESTED, '<abs-path>')
    .replace(POSIX_HOME_ABS, '<abs-path>')
}

/** Replace machine-specific prefixes with stable placeholders. */
export function redact(value) {
  if (typeof value === 'string') {
    let out = value
    for (const variant of [REPO_ROOT, REPO_ROOT.replace(/\\/g, '/'), REPO_ROOT.replace(/\//g, '\\')]) {
      out = out.split(variant).join('<repo>')
    }
    for (const variant of [HOME_DIR, HOME_DIR.replace(/\\/g, '/'), HOME_DIR.replace(/\//g, '\\')]) {
      out = out.split(variant).join('<user-home>')
    }
    if (HOSTNAME) out = out.split(HOSTNAME).join('<host>')
    return scrubPaths(out)
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = redact(inner)
    return out
  }
  return value
}

export const probeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Absolute path inside the probe directory. */
export function p(...segments) {
  return path.resolve(probeRoot, ...segments)
}

/** Create (or clear) an evidence directory and return a JSONL appender. */
export function createEvidence(name) {
  const dir = p('evidence', name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'records.jsonl')
  fs.writeFileSync(file, '')
  const append = (type, payload = {}) => {
    const record = redact({ ts: new Date().toISOString(), type, ...payload })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
    return record
  }
  const writeJson = (filename, value) => {
    const target = path.join(dir, filename)
    // Same redaction as the JSONL path: published evidence must never carry local
    // absolute paths, a user home directory or the hostname.
    fs.writeFileSync(target, `${JSON.stringify(redact(value), null, 2)}\n`)
    return target
  }
  return { dir, file, append, writeJson }
}

/** Human-readable progress line; keeps stdout readable while JSONL stays canonical. */
export function step(label, detail) {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  process.stdout.write(`[probe] ${label}${suffix}\n`)
}
