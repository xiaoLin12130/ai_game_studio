/**
 * Replace absolute paths in evidence text without touching the words around them.
 *
 * The first version of this used `[^"'\r\n]*` after the drive letter, which swallowed the
 * rest of the line: "H: 盘 store（H:\\dev\\pnpm-store\\v11）发生失败" became
 * "H: 盘 store（<store-path>" — the closing bracket and the conclusion were gone. Evidence
 * that loses its conclusion is worse than evidence with a path in it.
 *
 * The path body now stops at whitespace, quotes, and CJK punctuation, so a path is replaced
 * and everything after it survives. A bare drive reference ("H: 盘") is not a path and is
 * left alone.
 */

/** Characters that end a path: whitespace, quotes, and CJK/full-width punctuation. */
const PATH_STOP = /[\s"'\u3000-\u303f\uff00-\uffef]/

const isPathChar = (ch) => !PATH_STOP.test(ch)

/**
 * Find the end of a path that starts at `start` (the drive letter).
 * @param {string} text
 * @param {number} start
 * @returns {number} index just past the last path character
 */
function pathEnd(text, start) {
  let i = start
  while (i < text.length && isPathChar(text[i])) i += 1
  // A trailing separator is punctuation, not part of the path.
  while (i > start && /[\\/]/.test(text[i - 1])) i -= 1
  return i
}

/**
 * Pick a placeholder that keeps different paths distinguishable.
 * @param {string} path
 * @returns {string}
 */
export function placeholderFor(path) {
  if (/pnpm-store/i.test(path)) return /^[Hh]:/.test(path) ? '<H-drive-pnpm-store>' : '<C-temp-pnpm-store>'
  if (/win-unpacked|release-r\d|AI_Game_Studio/i.test(path)) return '<install-directory>'
  if (/AppData[\\/]Local[\\/]Temp/i.test(path)) return '<temp-dir>'
  if (/Users[\\/][^\\/]+/.test(path)) return '<user-home>'
  return '<abs-path>'
}

/**
 * Redact absolute paths in one string.
 * @param {string} text
 * @returns {string}
 */
export function redactPaths(text) {
  if (typeof text !== 'string') return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const drive = /^[A-Za-z]:[\\/]/.test(text.slice(i))
    if (drive) {
      const end = pathEnd(text, i)
      out += placeholderFor(text.slice(i, end))
      i = end
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

/** Redact every string inside a JSON value. */
export function redactDeep(value) {
  if (typeof value === 'string') return redactPaths(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]))
  }
  return value
}
