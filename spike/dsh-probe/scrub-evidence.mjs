#!/usr/bin/env node
/**
 * Rewrites published evidence and docs so no machine-specific path survives.
 *
 * Evidence written before the redaction fix (the 0.1.5 legacy snapshots, plus any doc
 * authored earlier) still contains absolute paths. Prefix substitution alone was not
 * enough there, for two separate reasons:
 *
 *   1. A process command line returns from the OS in the console code page, so a path
 *      with non-ASCII characters arrives mojibake'd and no longer matches the Unicode
 *      repository root.
 *   2. Raw JSON text still carries escape sequences: a path preceded by an escaped
 *      newline appears as `nF:\\...`, so a boundary-based pattern cannot tell it apart
 *      from prose. Decoding JSON first gives real separators.
 *
 * Usage:  node scrub-evidence.mjs [--check]
 *   --check   report only, exit 1 when a real path remains (used by the review gate)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './current-0.2.1/src/lib/evidence.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGETS = [
  'spike/dsh-probe/evidence',
  'spike/dsh-probe/legacy-0.1.5/evidence',
  'spike/dsh-probe/current-0.2.1/evidence',
  'docs',
]

/** A real leak: a drive letter followed by a path segment, or a POSIX home path. */
const LEAK = /[A-Za-z]:\\\\[A-Za-z]|[A-Za-z]:\/(?:Users|AI|Program|Windows|dev)\/|\/(?:Users|home)\/[A-Za-z]/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(json|jsonl|txt|md)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Scrub one file. JSON is decoded first so paths carry real separators; plain text is
 * scrubbed as-is.
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
const stillLeaking = []

for (const target of TARGETS) {
  for (const file of walk(path.join(ROOT, target))) {
    const before = fs.readFileSync(file, 'utf8')
    const after = scrubFile(file, before)
    scanned += 1
    if (after !== before) {
      if (!checkOnly) fs.writeFileSync(file, after)
      rewritten += 1
    }
    const subject = checkOnly ? before : after
    // Re-check the decoded form as well: raw text always trips on escape sequences.
    const decoded = file.endsWith('.json') || file.endsWith('.jsonl') ? subject.replace(/\\\\/g, '\\') : subject
    if (LEAK.test(decoded)) stillLeaking.push(path.relative(ROOT, file))
  }
}

process.stdout.write(`[scrub] scanned=${scanned} rewritten=${rewritten}${checkOnly ? ' (check only)' : ''}\n`)
if (stillLeaking.length) {
  process.stdout.write(`[scrub] STILL LEAKING (${stillLeaking.length}):\n`)
  for (const f of stillLeaking.slice(0, 20)) process.stdout.write(`  ${f}\n`)
  process.exit(1)
}
process.stdout.write('[scrub] no absolute paths remain\n')
