#!/usr/bin/env node
/**
 * Leak gate and maintenance tool for the published repository.
 *
 * The scanning logic lives in `current-0.2.1/src/lib/scrub.mjs`, because the same code
 * runs as a suite gate inside `run-all.mjs`. A report that says "scanned, clean" is only
 * worth something if the gate that produced it is the gate that also fails the build.
 *
 * Two modes:
 *   default   rewrite data/doc files that still contain paths, then re-scan and report
 *   --check   report only; exit 1 on any leak, scan error or empty scope
 *
 * Rewriting is limited to evidence, docs, state and memory-bank. Source files are
 * scanned but never rewritten: mutating code to satisfy a text matcher is a silent
 * behaviour change.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact, redactText } from './current-0.2.1/src/lib/redact.mjs'
import { scanTree } from './current-0.2.1/src/lib/scrub.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * `--root` and `--mode` exist for the regression tests, which point the CLI at a fixture
 * tree and assert the exit code. Running against the repository needs neither.
 */
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const checkOnly = argv.includes('--check')
const ROOT = path.resolve(option('--root', path.resolve(HERE, '..', '..')))
const MODE = option('--mode', 'git')
const isRepositoryRoot = ROOT === path.resolve(HERE, '..', '..')

/** Directories whose files may be rewritten in place. */
const REWRITABLE = [
  'spike/dsh-probe/evidence',
  'spike/dsh-probe/legacy-0.1.5/evidence',
  'spike/dsh-probe/current-0.2.1/evidence',
  'docs',
  'state',
  'memory-bank',
]

function isRewritable(rel) {
  const normalized = rel.split(path.sep).join('/')
  return REWRITABLE.some((prefix) => normalized.startsWith(`${prefix}/`))
}

/** JSON/JSONL keep their structure; everything else is scrubbed as text. */
function rewrite(file, text) {
  if (file.endsWith('.json')) {
    try {
      return `${JSON.stringify(redact(JSON.parse(text)), null, 2)}\n`
    } catch {
      return redactText(text)
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
          return redactText(line)
        }
      })
    return `${lines.join('\n')}\n`
  }
  return redactText(text)
}

let rewritten = 0

if (!checkOnly && isRepositoryRoot) {
  const first = scanTree({ root: ROOT, mode: MODE, requireFiles: true })
  for (const leak of first.leaks) {
    if (!isRewritable(leak.file)) continue
    const file = path.join(ROOT, leak.file)
    const before = fs.readFileSync(file, 'utf8')
    const after = rewrite(file, before)
    if (after !== before) {
      fs.writeFileSync(file, after)
      rewritten += 1
    }
  }
}

const result = scanTree({ root: ROOT, mode: MODE, requireFiles: true })
process.stdout.write(`[scrub] mode=${result.mode} files=${result.files} scanned=${result.scanned} rewritten=${rewritten}\n`)

if (result.errors.length) {
  process.stdout.write(`[scrub] SCAN ERRORS (${result.errors.length}):\n`)
  for (const error of result.errors.slice(0, 20)) {
    process.stdout.write(`  ${error.stage}${error.file ? ` ${error.file}` : ''}: ${error.message}\n`)
  }
  process.exit(1)
}

if (result.leaks.length) {
  process.stdout.write(`[scrub] LEAKS (${result.leaks.length}):\n`)
  for (const leak of result.leaks.slice(0, 40)) {
    process.stdout.write(`  ${leak.file}${leak.line ? `:${leak.line}` : ''}  [${leak.rule}]  ${leak.match}\n`)
  }
  process.exit(1)
}

process.stdout.write('[scrub] no absolute paths remain\n')
