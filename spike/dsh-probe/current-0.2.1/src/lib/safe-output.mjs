/**
 * The only place that writes to a stream.
 *
 * Every console write, every forwarded child-process chunk and every JSON dump goes
 * through here, so "did we forget to redact output X" stops being a question. The
 * previous design redacted at each call site, and each round of review found another
 * site that had been missed — stdout, then stderr, then the `--json` dump, then the
 * child forwards.
 */
import { redact, redactText } from './redact.mjs'

/** Write text to a stream after redaction. */
export function write(stream, text) {
  stream.write(redactText(String(text)))
}

/** Redacted stdout. */
export function out(text = '') {
  write(process.stdout, text)
}

/** Redacted stderr. */
export function err(text = '') {
  write(process.stderr, text)
}

/** One prefixed progress line on stdout. */
export function line(prefix, message = '') {
  out(message ? `[${prefix}] ${message}\n` : `[${prefix}]\n`)
}

/** Redacted, pretty-printed JSON to stdout (for `--json` modes). */
export function jsonOut(value) {
  out(`${JSON.stringify(redact(value), null, 2)}\n`)
}

/**
 * Forward a child stream to a destination, one complete line at a time.
 *
 * Chunk-level redaction is not enough: a path split across two chunks matches nothing
 * and survives. Line assembly guarantees each path is seen whole; the tail is flushed
 * on close so the last line is not dropped.
 */
export function createForwarder(destination) {
  let pending = ''
  return {
    push(chunk) {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const text of lines) write(destination, `${text}\n`)
    },
    flush() {
      if (pending) write(destination, pending)
      pending = ''
    },
  }
}

/** Forward both streams of a child process, returning a flush function. */
export function forwardChild(child) {
  const stdout = createForwarder(process.stdout)
  const stderr = createForwarder(process.stderr)
  child.stdout?.on('data', (chunk) => stdout.push(chunk))
  child.stderr?.on('data', (chunk) => stderr.push(chunk))
  return () => {
    stdout.flush()
    stderr.flush()
  }
}
