/**
 * The leak scanner, as a library.
 *
 * Three consumers share it: the CLI wrapper (`scrub-evidence.mjs`), the suite gate in
 * `run-all.mjs`, and the regression tests. When the gate and the report were separate
 * implementations, the report could describe a scan that never ran.
 *
 * Scope is "what would be published": every file git tracks, plus new files that are
 * not ignored. Ignored output (dependencies, generated DSH homes, build products) is
 * excluded by git itself rather than by a hand-written skip list, so the exclusion
 * cannot quietly grow into "everything that happens to fail".
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findLeaks, isAllowedLine } from './redact.mjs'

/** Files worth reading as text. Everything else is treated as binary and skipped. */
export const TEXT_FILE = /\.(md|markdown|json|jsonl|ndjson|txt|mjs|cjs|js|ts|tsx|yml|yaml|csv|log|html|css|xml|toml|ini|cfg)$/i

/**
 * Directories never descended into.
 *
 * Documented rather than incidental: `.git` holds object data, `node_modules` is
 * third-party code, and the rest are build or runtime output. In git mode none of
 * these can appear anyway (they are ignored), so this only affects the fallback walk.
 */
export const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']

/** Every string inside a parsed JSON value, keys included. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key)
      collectStrings(inner, out)
    }
  }
  return out
}

/** Decoded strings for structured files; the raw text for anything else. */
export function textUnits(file, text) {
  try {
    if (/\.(json|ndjson|jsonl)$/i.test(file)) {
      if (file.endsWith('.json')) return collectStrings(JSON.parse(text))
      return text
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return collectStrings(JSON.parse(l))
          } catch {
            return [l]
          }
        })
    }
  } catch {
    // invalid JSON: fall back to the raw text, which is still scanned
  }
  return [text]
}

/** Line number of a substring in the raw text, or null when it cannot be located. */
function locate(text, needle) {
  const at = text.indexOf(needle)
  if (at < 0) return null
  return text.slice(0, at).split('\n').length
}

/** Leaks in one file. Returns [] for clean files. */
export function scanText(file, text) {
  const hits = []
  for (const unit of textUnits(file, text)) {
    // Overlapping rules can describe the same span (a known-root path is also a nested
    // path). Report the longest match at each position once, so a single leak does not
    // look like several and the count stays meaningful.
    const byIndex = new Map()
    for (const leak of findLeaks(unit)) {
      const existing = byIndex.get(leak.index)
      if (!existing || leak.match.length > existing.match.length) byIndex.set(leak.index, leak)
    }

    for (const leak of byIndex.values()) {
      const lineNumber = locate(text, leak.match)
      if (lineNumber !== null) {
        const lineText = text.split('\n')[lineNumber - 1] ?? ''
        // Only that line opts out. Exempting the whole file would let a file that merely
        // mentions the marker escape the gate entirely — which is how the first version
        // of this check reported a clean tree while a comment two lines above held a path.
        if (isAllowedLine(lineText)) continue
      }
      hits.push({
        rule: leak.rule,
        match: leak.match.slice(0, 120),
        line: lineNumber,
      })
    }
  }
  return hits
}

/** Files git would publish: tracked, plus new-but-not-ignored. */
export function gitFiles(root) {
  const raw = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.split('\0').filter(Boolean)
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.includes(entry.name)) walk(path.join(dir, entry.name), out)
    } else {
      out.push(path.relative(dir, path.join(dir, entry.name)))
    }
  }
  return out
}

/**
 * Scan a tree.
 *
 * @param {object} options
 * @param {string} options.root      directory to scan
 * @param {'git'|'walk'} [options.mode]  `git` uses the publish set, `walk` reads the tree
 * @param {boolean} [options.requireFiles] fail when nothing was scanned
 * @returns {{ok:boolean, scanned:number, leaks:Array, errors:Array, mode:string, files:number}}
 */
export function scanTree({ root, mode = 'git', requireFiles = true }) {
  const leaks = []
  const errors = []
  let relativeFiles = []

  try {
    relativeFiles = mode === 'git' ? gitFiles(root) : walk(root)
  } catch (error) {
    errors.push({ stage: 'list', message: String(error?.message ?? error).slice(0, 300) })
    return { ok: false, scanned: 0, leaks, errors, mode, files: 0 }
  }

  const candidates = relativeFiles.filter((rel) => {
    const parts = rel.split(/[\\/]/)
    if (parts.some((part) => SKIP_DIRS.includes(part))) return false
    return TEXT_FILE.test(rel)
  })

  for (const rel of candidates) {
    const file = path.join(root, rel)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      // A file that cannot be read is an incomplete scan, never a clean one.
      errors.push({ stage: 'read', file: rel, message: String(error?.message ?? error).slice(0, 200) })
      continue
    }
    for (const hit of scanText(rel, text)) leaks.push({ file: rel, ...hit })
  }

  if (requireFiles && candidates.length === 0) {
    errors.push({ stage: 'scope', message: 'no text files were found to scan' })
  }

  return {
    ok: leaks.length === 0 && errors.length === 0,
    scanned: candidates.length,
    leaks,
    errors,
    mode,
    files: relativeFiles.length,
  }
}
