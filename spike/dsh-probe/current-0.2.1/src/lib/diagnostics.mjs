/**
 * Failure classification for the CLI probe.
 *
 * The model writes its reasoning to stderr as well as stdout, so any implementation that
 * keeps a "tail" of either stream ends up publishing chain-of-thought. This module keeps
 * only a category.
 *
 * It is also the only reason CC-0 can report a provider failure: inspecting a single
 * stream misclassifies failures that the runtime writes to the other one.
 */

/**
 * Signatures, most specific first.
 *
 * `PLUGIN_INCOMPATIBLE` matters most: when the profile cannot load the provider the
 * runtime silently falls back to another one, and the resulting quota error looks like
 * "the user's model is broken".
 */
export const ERROR_SIGNATURES = [
  { kind: 'PLUGIN_INCOMPATIBLE', re: /is incompatible with dsh/i },
  { kind: 'QUOTA', re: /QUOTA|Insufficient Balance/i },
  { kind: 'AUTH', re: /\b401\b|\b403\b|unauthori[sz]ed|invalid api key/i },
  { kind: 'PROFILE_BOOT', re: /JSON-RPC input closed|writer lock|profile .* not found/i },
  { kind: 'TIMEOUT', re: /timed out|ETIMEDOUT/i },
]

/**
 * Classify a finished run from both streams.
 *
 * Returns the failure kind (or null), the byte counts, and which streams matched — never
 * the text that matched. `matchedIn` exists because "only stderr had it" is a fact worth
 * asserting in tests.
 *
 * @param {{stdout?: string, stderr?: string}} streams
 */
export function classifyRun({ stdout = '', stderr = '' } = {}) {
  const haystacks = [
    { stream: 'stdout', text: String(stdout) },
    { stream: 'stderr', text: String(stderr) },
  ]

  let hit = null
  const matchedIn = []
  for (const signature of ERROR_SIGNATURES) {
    const streams = haystacks.filter((h) => signature.re.test(h.text)).map((h) => h.stream)
    if (streams.length === 0) continue
    matchedIn.push(...streams)
    if (!hit) hit = signature.kind
  }

  return {
    kind: hit,
    matchedIn: [...new Set(matchedIn)],
    stdoutBytes: String(stdout).length,
    stderrBytes: String(stderr).length,
  }
}

/** Kinds an operator can fix without changing code: reported as BLOCKED, not FAIL. */
export const BLOCKING_KINDS = ['QUOTA', 'AUTH']
