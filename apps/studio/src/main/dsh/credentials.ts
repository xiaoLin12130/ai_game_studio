/**
 * Reading the user's own DSH credential.
 *
 * The runtime authenticates with an environment variable (`apiKeyEnv` in the provider row),
 * and nothing in the app was putting one there: a fresh install could start a runtime and
 * then watch every model call fail with no explanation.
 *
 * The credential is read from the user's own DSH home, handed to the child process, and
 * never logged, never written to the database, and never included in evidence.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CredentialResult {
  ok: boolean
  /** The variable name the provider expects. */
  variable: string
  /** The secret, or null. Never log this. */
  value: string | null
  /** Where it came from, for diagnostics. Never the value itself. */
  source: string | null
  detail: string
}

/**
 * Where the credential file is.
 *
 * The app runs runtimes against its own isolated DSH home, but the user's credential lives
 * in their real one — that is where DSH itself put it, and where the user would look. So the
 * isolated home is checked first (a user may have provisioned it deliberately) and the real
 * home second.
 */
export function credentialCandidates(dshHome?: string | null): string[] {
  const candidates: string[] = []
  if (dshHome && dshHome.trim().length > 0) candidates.push(path.join(dshHome, '.credentials.yaml'))
  candidates.push(path.join(os.homedir(), '.dsh', '.credentials.yaml'))
  return candidates
}

/** The first credential file that exists, or the real home's path when none does. */
export function credentialFile(dshHome?: string | null): string {
  const candidates = credentialCandidates(dshHome)
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  return found ?? candidates[candidates.length - 1]
}

/**
 * Read one key from the credentials file.
 *
 * The file is YAML with quoted values that may wrap across lines; the regex handles the
 * quoted form and joins continuations. A missing file or key is a result, not an exception.
 */
export function readCredential(variable: string, dshHome?: string | null): CredentialResult {
  const file = credentialFile(dshHome)
  if (!fs.existsSync(file)) {
    return { ok: false, variable, value: null, source: null, detail: '凭据文件不存在：' + file }
  }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, variable, value: null, source: null, detail: '无法读取凭据文件：' + String((error as Error)?.message ?? error) }
  }
  // The file stores keys under a refs block, and a long value wraps with a trailing
  // backslash. Both forms have to be handled: a plain "key: value" and the quoted,
  // line-continued form DSH itself writes.
  const quoted = new RegExp(variable + '\\s*:\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)"').exec(text)
  const bare = new RegExp(variable + '\\s*:\\s*([^\\s"\'{}\\[\\],]+)').exec(text)
  const match = quoted ?? bare
  if (!match) {
    return { ok: false, variable, value: null, source: file, detail: '凭据文件中没有 ' + variable }
  }
  const value = match[1].replace(/\\\r?\n\s*/g, '').trim()
  if (value.trim().length === 0) {
    return { ok: false, variable, value: null, source: file, detail: variable + ' 为空' }
  }
  return { ok: true, variable, value, source: file, detail: '已从凭据文件读取' }
}

/**
 * The environment a runtime child should inherit.
 *
 * An explicit value in the current environment wins: a user who exported the variable meant
 * it. Otherwise the credential file is consulted.
 */
export function withCredential(
  base: NodeJS.ProcessEnv,
  variable: string,
  dshHome?: string | null,
): { env: NodeJS.ProcessEnv; result: CredentialResult } {
  if (base[variable] && String(base[variable]).trim().length > 0) {
    return {
      env: { ...base },
      result: { ok: true, variable, value: null, source: 'environment', detail: '已从环境变量读取' },
    }
  }
  const result = readCredential(variable, dshHome)
  const env = { ...base }
  if (result.ok && result.value) env[variable] = result.value
  return { env, result }
}
