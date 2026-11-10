/**
 * Evidence logging helpers for the PHASE 00 DSH probe.
 *
 * Every probe appends structured records to a JSONL file so the report can cite
 * machine-checkable facts instead of prose.
 *
 * The evidence is published in a public repository, so everything written here passes
 * through the shared redaction module: local user directories, the hostname, the
 * repository root and any remaining absolute path become placeholders. What is removed
 * is machine identity, never a fact a reviewer needs.
 *
 * The stream helpers live in `safe-output.mjs`; this module only adds files.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact, redactText, REPO_ROOT } from './redact.mjs'
import { out } from './safe-output.mjs'

export { redact, redactText, scrubPaths, PROBE_ROOT } from './redact.mjs'

/** `spike/dsh-probe/current-0.2.1` — the directory this probe suite owns. */
export const probeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export { REPO_ROOT }

/** Absolute path inside the probe directory. */
export function p(...segments) {
  return path.resolve(probeRoot, ...segments)
}

/**
 * Write a JSON file with redaction applied to every string inside it.
 *
 * This is the only JSON writer for evidence: a second writer is how `summary.json`
 * ended up unredacted while `records.jsonl` was redacted.
 */
export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(redact(value), null, 2)}\n`)
  return file
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
  const writeJson = (filename, value) => writeJsonFile(path.join(dir, filename), value)
  return { dir, file, append, writeJson }
}

/** Human-readable progress line; redacted by the shared output layer. */
export function step(label, detail) {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  out(`[probe] ${label}${suffix}\n`)
}
