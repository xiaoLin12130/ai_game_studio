/**
 * Distinguishes "our integration is broken" from "the model provider refused".
 *
 * PHASE 00 hit a real 402 QUOTA failure on the DeepSeek account. Treating that as
 * a generic probe failure would hide the fact that the runtime, session, event
 * and teardown machinery all worked. Treating it as a pass would be dishonest.
 * So probes report three outcomes:
 *
 *   PASS    — the assertion held
 *   BLOCKED — infrastructure ran, but an external dependency (model quota,
 *             missing platform tool) prevented the specific assertion
 *   FAIL    — our code or the environment is wrong
 *
 * Exit codes: 0 PASS, 3 BLOCKED, 1 FAIL.
 */
export const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 3 }

/** Scan session events for a provider-side refusal rather than a harness fault. */
export function detectModelBlocker(events = []) {
  for (const event of events) {
    const data = event?.data ?? {}
    const candidates = []
    if (data.reason) candidates.push(data.reason)
    if (data.error) candidates.push(data.error)
    for (const stream of data.stream ?? []) {
      if (stream?.chunk?.reason) candidates.push(stream.chunk.reason)
    }
    for (const candidate of candidates) {
      const failure = candidate?.failure ?? candidate?.error ?? candidate
      const message = String(failure?.message ?? candidate?.message ?? '')
      const code = String(failure?.code ?? candidate?.code ?? '')
      const status = failure?.status ?? candidate?.status
      if (code === 'QUOTA' || status === 402 || /insufficient balance/i.test(message)) {
        return {
          blocked: true,
          kind: 'MODEL_QUOTA',
          code: code || 'QUOTA',
          status: status ?? 402,
          message: message.slice(0, 300),
        }
      }
      if (/unauthorized|invalid api key|401/i.test(message) || status === 401) {
        return { blocked: true, kind: 'MODEL_AUTH', code: code || 'AUTH', status: status ?? 401, message: message.slice(0, 300) }
      }
    }
  }
  return { blocked: false }
}

/** Name of the MCP tool the Studio server exposes. */
export const STUDIO_TOOL_NAME = 'mcp__studio__get_studio_health'

/**
 * Read the tool roster the runtime advertised for a model request.
 * `request/header` is emitted before the provider is contacted, which is exactly
 * why it is still usable evidence when the model call itself fails.
 */
export function advertisedTools(events = []) {
  const header = events.find((e) => e?.type === 'request/header')
  const tools = header?.data?.header?.tools
  if (!Array.isArray(tools)) return null
  return tools.map((t) => t?.name).filter((n) => typeof n === 'string')
}

/**
 * The provider/model route the runtime actually used for a turn.
 *
 * `request/header` is emitted before the provider is contacted, so it survives a
 * failed model call — which is exactly when a silent provider fallback would
 * otherwise be mistaken for "the user's model is broken".
 *
 * @param {Array} events session events for the interval
 * @returns {{provider: string|null, model: string|null, maxTokens: number|null}|null}
 */
export function requestRoute(events = []) {
  const header = events.find((event) => event?.type === 'request/header')
  const config = header?.data?.header?.config
  if (!config) return null
  return {
    provider: config.provider ?? null,
    model: config.model ?? null,
    maxTokens: config.maxTokens ?? null,
  }
}

/** True only when the turn really ran on the expected provider and model. */
export function routeMatches(route, expected) {
  return Boolean(route) && route.provider === expected.provider && route.model === expected.model
}
