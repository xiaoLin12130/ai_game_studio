/**
 * Append-only JSON-lines log with size rotation and field redaction.
 *
 * The log is the only place a user can look when "the status card says failed" — so it
 * records decisions, durations and first error lines, and nothing that could carry a
 * credential. Redaction is a pure function so it can be tested directly.
 */
import fs from 'node:fs'
import path from 'node:path'

export const LOG_FILE = 'studio.log'
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
export const DEFAULT_KEEP = 3

const SECRET_KEY = /(token|secret|password|passwd|credential|api[-_]?key|authorization)/i

/** Anything that looks like a credential is masked even when the key name is innocent. */
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{16,})/g

export function redactString(value: string): string {
  return value.replace(SECRET_VALUE, '<credential>')
}

/** Deep-redact a field bag: secret-looking keys are replaced, strings are pattern-scrubbed. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, key))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        out[childKey] = walk(childValue, childKey)
      }
      return out
    }
    if (key !== null && SECRET_KEY.test(key) && value !== null && value !== undefined) return '<redacted>'
    if (typeof value === 'string') return redactString(value)
    return value
  }
  return walk(fields, null) as Record<string, unknown>
}

/** Rotate when the active file would exceed `maxBytes`; returns the files to keep. */
export function rotationTargets(file: string, existingSize: number, maxBytes: number, keep: number): string[] {
  if (existingSize + 1 <= maxBytes) return []
  const targets: string[] = []
  for (let index = keep - 1; index >= 1; index -= 1) targets.push(`${file}.${index}`)
  return targets
}

export interface Logger {
  path: string
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export interface LoggerOptions {
  maxBytes?: number
  keep?: number
  now?: () => Date
}

/**
 * Create the logger, rotating an oversized file once at startup.
 *
 * Rotation happens on open rather than per write: a probe writes a handful of lines, so
 * checking the size on every line would be noise for no benefit.
 */
export function createLogger(logDir: string, options: LoggerOptions = {}): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = options.keep ?? DEFAULT_KEEP
  const now = options.now ?? (() => new Date())
  fs.mkdirSync(logDir, { recursive: true })
  const file = path.join(logDir, LOG_FILE)

  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    size = 0
  }
  if (size > maxBytes) {
    for (let index = keep; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`
      const to = `${file}.${index}`
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to)
      } catch {
        /* rotation is best effort; losing an old file must not stop the app */
      }
    }
  }

  const write = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) => {
    const record = { ts: now().toISOString(), level, event, ...redactFields(fields) }
    try {
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* a full disk must not crash the status card */
    }
  }

  return {
    path: file,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
