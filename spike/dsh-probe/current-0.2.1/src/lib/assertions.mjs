/**
 * Pure predicates shared by the probes and their regression tests.
 *
 * These live outside the probes on purpose: an assertion that can only be exercised by
 * running a live model is an assertion nobody can prove is wrong. Each predicate here is
 * small enough to test with hand-written inputs, including the inputs that must fail —
 * an empty list, a foreign session id, a mixed list.
 */

/**
 * Are all notifications for exactly this session, and was there at least one?
 *
 * `every()` on an empty array is `true`, which is how "no notification arrived at all"
 * once passed as "perfect isolation". The length check is the point.
 *
 * @param {string[]} ids session ids observed
 * @param {string} ownSessionId the session under test
 */
export function notificationsIsolated(ids, ownSessionId) {
  if (!Array.isArray(ids) || ids.length === 0) return false
  if (!ownSessionId) return false
  return ids.every((id) => id === ownSessionId)
}

/**
 * Is every model request in the window on the expected route?
 *
 * Requires at least one observation: no `request/header` means the route was never
 * proven, so the answer must be false rather than vacuously true.
 *
 * @param {Array<{provider: string|null, model: string|null}>} routes
 * @param {{provider: string, model: string}} expected
 */
export function routesAllMatch(routes, expected) {
  if (!Array.isArray(routes) || routes.length === 0) return false
  return routes.every((route) => route.provider === expected.provider && route.model === expected.model)
}

/**
 * Summarise which routes were seen, so evidence records the shape of the run rather
 * than just a boolean. A reviewer can then see that only one hop was observed.
 */
export function summariseRoutes(routes) {
  const list = Array.isArray(routes) ? routes : []
  return {
    count: list.length,
    distinct: [...new Set(list.map((r) => `${r.provider ?? 'null'}|${r.model ?? 'null'}`))],
    multiHopObserved: list.length > 1,
  }
}
