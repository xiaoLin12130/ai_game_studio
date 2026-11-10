#!/usr/bin/env node
/**
 * Scrubs published evidence and docs, then verifies the whole repository is clean.
 *
 * Two earlier versions of this script were wrong in ways that made its "clean" verdict
 * meaningless, so both bugs are recorded here:
 *
 *   1. It only walked four directories (`evidence/`, `docs/`). `state/`,
 *      `memory-bank/`, `README.md` and the sources were never scanned at all.
 *   2. Its Windows pattern required TWO backslashes (`C:\\Users`) while a decoded path
 *      has one (`C:\Users`). Since the script decodes JSON before matching, a real
 *      leak could never match. The check passed because it could not see anything.
 *
 * Both forms are matched now, and the whole repository is scanned.
 *
 * Rewriting and detecting are deliberately separate:
 *   - data/doc files (evidence, docs, state, memory-bank) are rewritten in place;
 *   - source files are only ever *reported*. Rewriting code to satisfy a text matcher
 *     would be a silent behaviour change, and some of those files legitimately contain
 *     regex shapes that look like paths.
 *
 * Usage:  node scrub-evidence.mjs [--check]
 *   --check   report only, exit 1 when a real path remains (used by the review gate)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './current-0.2.1/src/lib/evidence.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * This file is the one exception: it has to quote the shapes it looks for, so it
 * matches itself. Everything else is checked, including the rest of the sources.
 */
const SELF = fileURLToPath(import.meta.url)

/** Directories that are never content: VCS, dependencies, throwaway build output. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'dist', 'build', 'out', 'coverage'])

/** Files that are worth reading as text. Everything else is skipped as binary. */
const TEXT_FILE = /\.(md|json|jsonl|txt|mjs|cjs|js|ts|tsx|yml|yaml|csv|log|html|css)$/i

/** Directories whose files are rewritten, not merely reported. */
const REWRITABLE = [
  'spike/dsh-probe/evidence',
  'spike/dsh-probe/legacy-0.1.5/evidence',
  'spike/dsh-probe/current-0.2.1/evidence',
  'docs',
  'state',
  'memory-bank',
]

/**
 * A real leak, expressed so JSON escape sequences cannot fake one.
 *
 * A drive letter followed by a single `\` is not enough: in raw text `c:\n` and
 * `s:\t` look exactly like paths, and matching them produced 24 false positives that
 * buried the two real hits. Requiring a second separator (`C:\dir\file`) removes the
 * ambiguity, because an escape pair never spans one. Known Windows roots are matched
 * separately so a shallow path like `C:\Users` is still caught.
 */
const LEAK_PATTERNS = [
  /(?<![A-Za-z0-9])[A-Za-z]:\\[^\\\s"',;)]*\\[^\\\s"',;)]*/, // decoded: C:\dir\file
  /(?<![A-Za-z0-9])[A-Za-z]:\/[^/\s"',;)]*\/[^/\s"',;)]*/, // forward slashes
  /(?<![A-Za-z0-9])[A-Za-z]:\\(?:Users|Windows|Program Files|AI|dev|home)\\/i, // shallow but known
  /\/(?:Users|home)\/[A-Za-z][^/\s"',;)]+/, // POSIX home
]

/** Every string inside a parsed JSON value, so matching happens on decoded text. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) collectStrings(inner, out)
  return out
}

/** Decoded strings for structured files; the raw text for anything else. */
function textUnits(file, text) {
  try {
    if (file.endsWith('.json')) return collectStrings(JSON.parse(text))
    if (file.endsWith('.jsonl')) {
      return text
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return collectStrings(JSON.parse(line))
          } catch {
            return [line]
          }
        })
    }
  } catch {
    // fall through to raw text
  }
  return [text]
}

/** First leaking string, with a little context for the report. */
function firstLeak(file, text) {
  for (const unit of textUnits(file, text)) {
    for (const pattern of LEAK_PATTERNS) {
      const match = unit.match(pattern)
      if (!match) continue
      const at = unit.indexOf(match[0])
      return {
        text: unit.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ').trim(),
      }
    }
  }
  return null
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out)
    } else if (TEXT_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/**
 * The set to scan: exactly what would be published.
 *
 * `git ls-files --cached --others --exclude-standard` returns tracked files plus new
 * files that are not ignored — no `node_modules`, no generated `dsh-home`, no other
 * build output. Walking the directory tree instead would report thousands of leaks in
 * files that never reach the repository, and would drown the real ones.
 */
function listFiles() {
  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return raw
      .split('\0')
      .filter(Boolean)
      .filter((rel) => TEXT_FILE.test(rel) && !rel.split('/').some((part) => SKIP_DIRS.has(part)))
      .map((rel) => path.join(ROOT, rel))
      .filter((file) => fs.existsSync(file))
  } catch {
    // No git available (a source tarball, say): fall back to a filtered tree walk.
    return walk(ROOT)
  }
}

function isRewritable(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  return REWRITABLE.some((prefix) => rel.startsWith(`${prefix}/`))
}

/**
 * Scrub one data file. JSON is decoded first so paths carry real separators; plain text
 * is scrubbed as-is. Returns the new text.
 */
function scrubFile(file, text) {
  if (file.endsWith('.json')) {
    try {
      return `${JSON.stringify(redact(JSON.parse(text)), null, 2)}\n`
    } catch {
      return redact(text)
    }
  }
  if (file.endsWith('.jsonl')) {
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.stringify(redact(JSON.parse(line)))
        } catch {
          return redact(line)
        }
      })
    return `${lines.join('\n')}\n`
  }
  return redact(text)
}

const checkOnly = process.argv.includes('--check')
let scanned = 0
let rewritten = 0
const leaks = []

for (const file of listFiles()) {
  if (path.resolve(file) === SELF) continue
  const before = fs.readFileSync(file, 'utf8')
  scanned += 1
  let subject = before

  if (!checkOnly && isRewritable(file)) {
    const after = scrubFile(file, before)
    if (after !== before) {
      fs.writeFileSync(file, after)
      rewritten += 1
      subject = after
    }
  }

  const hit = firstLeak(file, subject)
  if (hit) leaks.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), line: hit.line ?? null, text: hit.text })
}

process.stdout.write(`[scrub] scanned=${scanned} rewritten=${rewritten}${checkOnly ? ' (check only)' : ''}\n`)
if (leaks.length) {
  process.stdout.write(`[scrub] LEAKS (${leaks.length}):\n`)
  for (const leak of leaks.slice(0, 25)) process.stdout.write(`  ${leak.file}:${leak.line}  ${leak.text}\n`)
  process.exit(1)
}
process.stdout.write('[scrub] no absolute paths remain\n')
