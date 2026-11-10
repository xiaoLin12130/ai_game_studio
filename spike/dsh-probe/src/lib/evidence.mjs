/**
 * Evidence logging helpers for the PHASE 00 DSH probe.
 * Every probe appends structured records to a JSONL file so the report can cite
 * machine-checkable facts instead of prose.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const record = { ts: new Date().toISOString(), type, ...payload }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
    return record
  }
  const writeJson = (filename, value) => {
    const target = path.join(dir, filename)
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
    return target
  }
  return { dir, file, append, writeJson }
}

/** Human-readable progress line; keeps stdout readable while JSONL stays canonical. */
export function step(label, detail) {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  process.stdout.write(`[probe] ${label}${suffix}\n`)
}
