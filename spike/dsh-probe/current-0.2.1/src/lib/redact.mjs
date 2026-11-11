/**
 * Single source of truth for redaction and leak detection.
 *
 * Why one module: redaction and detection were once written twice, in two places, with
 * different patterns, so the scanner could report clean while evidence still leaked.
 * Every rule added here applies to both directions at once.
 *
 * R1.4.1 adds two rule families the previous version lacked:
 *   - credentials (API keys, bearer tokens, JWTs, private keys, assigned secrets);
 *   - Windows paths whose directory names contain spaces, which the old segment class
 *     excluded because it rejected all whitespace.
 *
 * The rules are shape-based, not prefix-based. A prefix list can never be complete:
 * evidence recorded before a directory rename kept leaking, and a path captured from
 * the OS in the console code page arrives mojibake'd and matches nothing at all.
 *
 * Shape rules can match text that is not a leak, so two safeguards apply:
 *   - a path needs two separators, a known system root, or an explicitly space-bearing
 *     segment, which keeps JSON escapes such as `note:\n` out;
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
export const CREDENTIAL_PLACEHOLDER = '<credential>'

/**
 * Detection / redaction rules, most specific first.
 *
 * `replacement` is what `String.replace` receives, so `$1` can preserve a prefix.
 * Each rule has an id: the gate reports which rule fired, which is more useful than a
 * bare "leak found".
 */
export const LEAK_RULES = [
  {
    id: 'credential-private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
    replacement: CREDENTIAL_PLACEHOLDER,
  },
  {
    id: 'credential-jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    replacement: CREDENTIAL_PLACEHOLDER,
  },
  {
    id: 'credential-bearer',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
    replacement: 'Bearer ' + CREDENTIAL_PLACEHOLDER,
  },
  {
    id: 'credential-openai',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/,
    replacement: CREDENTIAL_PLACEHOLDER,
  },
  {
    id: 'credential-github',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    replacement: CREDENTIAL_PLACEHOLDER,
  },
  {
    id: 'credential-aws',
    re: /\bAKIA[0-9A-Z]{12,}\b/,
    replacement: CREDENTIAL_PLACEHOLDER,
  },
  {
    id: 'credential-assigned',
    // Keeps the variable name, replaces only its value.
    re: /(api[_-]?key|access[_-]?token|secret|password|passwd|COMMANDCODE_API_KEY|DEEPSEEK_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
    replacement: '$1=<credential>',
  },
  {
    id: 'windows-unc',
    // Shape: two leading separators, then host and share. scrub:allow
    re: /(?<![A-Za-z0-9])\\\\[A-Za-z0-9._$-]+\\[^\\\r\n"',;)]+/, // scrub:allow
    replacement: ABS_PLACEHOLDER,
  },
  {
    id: 'windows-nested',
    // Drive + two or more complete segments. The segment class deliberately allows
    // spaces (R1.4.1: a drive path with a directory name containing a space, which used
    // to be invisible) and excludes only backslash, line breaks and JSON delimiters.
    // excludes only backslash, line breaks and JSON delimiters. It is a single
    // non-nested repetition, so it stays linear even on very long lines — the first
    // attempt used a nested `*` quantifier and exhausted the heap on evidence files.
    // Two separators also keep JSON escapes such as `note:\n` out.
    re: /(?<![A-Za-z0-9])[A-Za-z]:\\[^\\\r\n"',;)]+(?:\\[^\\\r\n"',;)]+)+/,
    replacement: ABS_PLACEHOLDER,
  },
  {
    id: 'windows-known',
    // Shallow but unambiguous: a system root immediately after the drive.
    re: /(?<![A-Za-z0-9])[A-Za-z]:\\(?:Users|Windows|Program Files|ProgramData|Documents and Settings)\\/i,
    replacement: ABS_PLACEHOLDER,
  },
  {
    id: 'windows-forward',
    // Shape: drive + forward slashes + at least one complete segment. scrub:allow
    re: /(?<![A-Za-z0-9])[A-Za-z]:\/(?:[^/\r\n"',;)]+\/)+[^/\r\n"',;)]*/,
    replacement: ABS_PLACEHOLDER,
  },
  {
    id: 'posix-rooted',
    // The lookbehind keeps host paths out of URLs: in `https://host/home/x` the
    // character before the slash is a hostname character, so it does not match.
    re: /(?<![A-Za-z0-9._-])\/(?:Users|home|root|mnt|tmp|opt|var|private|workspace|srv)\/[^\r\n"',;)]+/,
    replacement: ABS_PLACEHOLDER,
  },
]

/** Backwards-compatible alias: early callers only needed the path subset. */
export const PATH_RULES = LEAK_RULES.filter((rule) => !rule.id.startsWith('credential-'))

/** Global twin of each rule, built once so `replace` cannot inherit a stale lastIndex. */
const GLOBAL_RULES = LEAK_RULES.map((rule) => ({ ...rule, re: new RegExp(rule.re.source, `${rule.re.flags}g`) }))

/** Line marker: documentation that must show a path shape opts out explicitly. */
export const ALLOW_MARKER = 'scrub:allow'

/**
 * Collapse every leak in a string to a placeholder.
 *
 * The repository root and the user home are replaced by name first — that keeps the
 * evidence readable — and anything else that still has a path shape becomes
 * `<abs-path>`. Credential shapes become `<credential>`.
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
  for (const rule of GLOBAL_RULES) out = out.replace(rule.re, rule.replacement)
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
  for (const rule of LEAK_RULES) {
    // `g` is mandatory: without it `exec` always restarts at index 0 and returns the
    // same match forever. The source rules are deliberately non-global so the same
    // pattern can be reused for both `.test` and `.replace`.
    const re = new RegExp(rule.re.source, `${rule.re.flags}g`)
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
