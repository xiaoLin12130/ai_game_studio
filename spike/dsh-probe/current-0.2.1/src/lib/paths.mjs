/**
 * Where a probe keeps its isolated DSH home.
 *
 * A clean-room reproduction needs to point at a brand new directory, so every probe
 * resolves the home through this helper instead of hard-coding `./dsh-home`.
 * `CC_DSH_HOME` wins when set; otherwise `<probe>/dsh-home` is used.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const probeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function dshHomePath() {
  const override = process.env.CC_DSH_HOME
  return override ? path.resolve(override) : path.join(probeRoot, 'dsh-home')
}

export function workspacePath() {
  const override = process.env.CC_WORKSPACE
  return override ? path.resolve(override) : path.join(probeRoot, 'workspace')
}

export function patchDir() {
  const override = process.env.CC_PATCH_DIR
  return override ? path.resolve(override) : path.join(probeRoot, 'tmp')
}
