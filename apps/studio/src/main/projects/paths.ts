/**
 * Project root containment.
 *
 * A project's root directory is the boundary for every file operation the app performs on
 * its behalf. The check has to survive the ways Windows lets a path escape a directory:
 * `..` segments, a different drive, a UNC path, and a junction or symlink that points
 * outside. Comparing strings is not enough — `C:\\games\\proj` and `C:\\games\\proj2` share a
 * prefix, and `C:\\games\\proj\\..\\other` looks contained until it is resolved.
 *
 * So every check resolves both sides to their real path first, then compares whole path
 * segments. Anything that cannot be resolved is refused rather than assumed safe.
 */
import fs from 'node:fs'
import path from 'node:path'

export type PathRejection =
  | 'EMPTY'
  | 'NOT_ABSOLUTE'
  | 'ESCAPES_ROOT'
  | 'DIFFERENT_DRIVE'
  | 'UNC_NOT_ALLOWED'
  | 'SYMLINK_ESCAPE'
  | 'UNRESOLVABLE'

export class ProjectPathError extends Error {
  readonly code: PathRejection
  readonly attempted: string
  readonly root: string

  constructor(code: PathRejection, attempted: string, root: string, detail?: string) {
    super(`${code}: ${detail ?? 'path is not inside the project root'}`)
    this.name = 'ProjectPathError'
    this.code = code
    this.attempted = attempted
    this.root = root
  }
}

/** True for \\\\server\\share style paths, which this app does not support as project roots. */
export function isUncPath(value: string): boolean {
  return /^\\\\[^\\/]+[\\/]/.test(value)
}

/**
 * Resolve a path to its real location, following junctions and symlinks.
 *
 * The path may not exist yet (a file about to be created), so resolution walks up to the
 * nearest existing ancestor and re-attaches the remainder. That keeps the check honest for
 * new files without requiring them to exist first.
 */
export function realPathOf(target: string): string {
  const absolute = path.resolve(target)
  let current = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(current)
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) throw new ProjectPathError('UNRESOLVABLE', target, '', 'no existing ancestor')
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/** Compare two resolved paths segment by segment, case-insensitively on Windows. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = realPathOf(root)
  const candidateResolved = realPathOf(candidate)
  const normalise = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const rootParts = normalise(rootResolved).split(path.sep).filter(Boolean)
  const candidateParts = normalise(candidateResolved).split(path.sep).filter(Boolean)
  if (candidateParts.length < rootParts.length) return false
  for (let i = 0; i < rootParts.length; i += 1) {
    if (rootParts[i] !== candidateParts[i]) return false
  }
  return true
}

/**
 * Assert that `candidate` is inside `root`, or throw a typed error.
 *
 * Every rejection carries a code the caller can show to the user; nothing is swallowed.
 */
export function assertInsideProject(root: string, candidate: string): string {
  if (!candidate || candidate.trim().length === 0) {
    throw new ProjectPathError('EMPTY', candidate, root, 'no path was given')
  }
  if (isUncPath(candidate)) {
    throw new ProjectPathError('UNC_NOT_ALLOWED', candidate, root, 'network paths are not supported as project files')
  }
  if (!path.isAbsolute(candidate)) {
    throw new ProjectPathError('NOT_ABSOLUTE', candidate, root, 'relative paths are resolved against the project root only')
  }
  const rootResolved = realPathOf(root)
  const candidateResolved = realPathOf(candidate)
  const rootDrive = path.parse(rootResolved).root.toLowerCase()
  const candidateDrive = path.parse(candidateResolved).root.toLowerCase()
  if (rootDrive !== candidateDrive) {
    throw new ProjectPathError('DIFFERENT_DRIVE', candidate, root, 'the path is on a different volume')
  }
  if (!isInsideRoot(rootResolved, candidateResolved)) {
    throw new ProjectPathError('ESCAPES_ROOT', candidate, root, 'the resolved path is outside the project root')
  }
  return candidateResolved
}

/** Resolve a project-relative path and assert it stays inside. */
export function resolveInsideProject(root: string, relative: string): string {
  if (path.isAbsolute(relative)) return assertInsideProject(root, relative)
  return assertInsideProject(root, path.resolve(root, relative))
}

/**
 * Check whether a directory is usable as a project root.
 *
 * Returns a reason instead of throwing: the create-project form needs to show the user
 * what is wrong, not crash.
 */
export function inspectProjectRoot(candidate: string): {
  ok: boolean
  code: 'OK' | 'EMPTY' | 'NOT_ABSOLUTE' | 'UNC_NOT_ALLOWED' | 'NOT_A_DIRECTORY' | 'NOT_WRITABLE' | 'UNRESOLVABLE'
  detail: string
  resolved: string | null
} {
  if (!candidate || candidate.trim().length === 0) {
    return { ok: false, code: 'EMPTY', detail: '请选择一个项目目录。', resolved: null }
  }
  if (isUncPath(candidate)) {
    return { ok: false, code: 'UNC_NOT_ALLOWED', detail: '不支持网络路径作为项目目录。', resolved: null }
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, code: 'NOT_ABSOLUTE', detail: '请提供绝对路径。', resolved: null }
  }
  let resolved: string
  try {
    resolved = realPathOf(candidate)
  } catch {
    return { ok: false, code: 'UNRESOLVABLE', detail: '无法解析该路径。', resolved: null }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    return { ok: false, code: 'NOT_A_DIRECTORY', detail: '目录不存在。', resolved }
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'NOT_A_DIRECTORY', detail: '该路径不是目录。', resolved }
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    return { ok: false, code: 'NOT_WRITABLE', detail: '目录不可读写。', resolved }
  }
  return { ok: true, code: 'OK', detail: '目录可用。', resolved }
}
