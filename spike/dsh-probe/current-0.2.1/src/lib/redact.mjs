/**
 * Single source of truth for path redaction and leak detection.
 *
 * Why this module exists: redaction and detection used to be written twice, in two
 * places, with different patterns. The scrubber therefore "passed" while the writer
 * leaked, twice in a row. Any rule added here applies to both directions at once.
 *
 * The rules are shape-based, not prefix-based. A prefix list can never be complete —
 * the previous version only knew the current repository root, so evidence recorded
 * before a directory rename kept leaking, and a path captured from the OS in the
 * console code page (mojibake'd) matched nothing at all.
 *
 * Shape rules have a cost: they can match text that is not a path. Two safeguards:
 *   - detection requires either two separators, a known system root, or a UNC prefix,
 *     so a bare `x:\y` in prose is not treated as a leak;
 *   - `scrub:allow` on a line exempts it, for documentation that must show a shape.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** `spike/dsh-probe/current-0.2.1` */
export const PROBE_ROOT = path.resolve(HERE, '..', '..')
/** Repository root, three levels above the probe directory. */
export const REPO_ROOT = path.resolve(PROBE_ROOT, '..', '..', '..')
export const HOME_DIR = os.homedir()
export const HOSTNAME = os.hostname()

export const ABS_PLACEHOLDER = '<abs-path>'

/**
 * Detection / redaction rules.
 *
 * Order matters for replacement: the most specific shape must run first, otherwise a
 * generic rule consumes part of it and leaves the remainder behind.
 */
export const PATH_RULES = [
  {
    id: 'windows-unc',
    // Shape: \\server\share\... (two leading separators). scrub:allow
    re: /(?<![A-Za-z0-9])\\\\[A-Za-z0-9._$-]+\\[^\\\s"',;)]+/,
  },
  {
    id: 'windows-nested',
    // Two separators: cannot be confused with an escape sequence such as `note:\n`.
    re: /(?<![A-Za-z0-9])[A-Za-z]:\\[^\\\s"',;)]+\\[^\\\s"',;)]*/,
  },
  {
    id: 'windows-known',
    // Shallow but unambiguous: a system root immediately after the drive.
    re: /(?<![A-Za-z0-9])[A-Za-z]:\\(?:Users|Windows|Program Files|ProgramData|Documents and Settings)\\/i,
  },
  {
    id: 'windows-forward',
    // Shape: drive + forward slashes + at least one complete segment. scrub:allow
    re: /(?<![A-Za-z0-9])[A-Za-z]:\/(?:[^/\s"',;)]+\/)+[^/\s"',;)]*/,
  },
  {
    id: 'posix-rooted',
    // /Users, /home, /root, /mnt, /tmp, /opt, /var, /private, /workspace, /srv.
    // The lookbehind keeps host paths out of URLs: in `https://host/home/x` the
    // character before the slash is a hostname character, so it does not match.
    re: /(?<![A-Za-z0-9._-])\/(?:Users|home|root|mnt|tmp|opt|var|private|workspace|srv)\/[^\s"',;)]+/,
  },
]

/** Global twin of each rule, built once so `replace` cannot inherit a stale lastIndex. */
const GLOBAL_RULES = PATH_RULES.map((rule) => ({ id: rule.id, re: new RegExp(rule.re.source, 'g') }))

/** Line marker: documentation that must show a path shape opts out explicitly. */
export const ALLOW_MARKER = 'scrub:allow'

/**
 * Collapse every absolute path in a string to one placeholder.
 *
 * The repository root and the user home are replaced by name first — that keeps the
 * evidence readable — and anything else that still has a path shape becomes
 * `<abs-path>`.
 */
export function redactText(text) {
  let out = text
  for (const variant of [REPO_ROOT, REPO_ROOT.replace(/\\/g, '/'), REPO_ROOT.replace(/\//g, '\\')]) {
    out = out.split(variant).join('<repo>')
  }
  for (const variant of [HOME_DIR, HOME_DIR.replace(/\\/g, '/'), HOME_DIR.replace(/\//g, '\\')]) {
    out = out.split(variant).join('<user-home>')
  }
  if (HOSTNAME) out = out.split(HOSTNAME).join('<host>')
  for (const rule of GLOBAL_RULES) out = out.replace(rule.re, ABS_PLACEHOLDER)
  return out
}

/** Deep redaction. Strings are scrubbed; objects and arrays are walked. */
export function redact(value) {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = redact(inner)
    return out
  }
  return value
}

/** Backwards-compatible alias: older calls only needed the path part. */
export const scrubPaths = redactText

/**
 * Every leak found in one string.
 *
 * @param {string} text
 * @returns {Array<{rule: string, match: string, index: number}>}
 */
export function findLeaks(text) {
  const found = []
  for (const rule of PATH_RULES) {
    const re = new RegExp(rule.re.source, 'g')
    let hit
    while ((hit = re.exec(text)) !== null) {
      found.push({ rule: rule.id, match: hit[0], index: hit.index })
      if (hit[0].length === 0) re.lastIndex += 1
    }
  }
  return found
}

/** True when the line opts out of the gate. */
export function isAllowedLine(line) {
  return line.includes(ALLOW_MARKER)
}
