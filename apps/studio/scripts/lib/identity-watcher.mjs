/**
 * Watch an app for every DSH runtime it starts, then prove each one is gone.
 *
 * A task that interrupts and resumes owns two runtimes over its lifetime, so a single
 * capture cannot prove the scenario is clean. The watcher polls while the app lives and
 * remembers every distinct (pid, creationMs) it sees; the caller verifies each one after
 * the app has exited.
 *
 * Two properties matter more than polling speed:
 *
 *  - `stop()` drains the query already in flight. An identity that was being discovered
 *    when the app exited must still be recorded, otherwise a leaked runtime can be
 *    reported as gone. Setting a flag is not enough; the pending promise has to settle.
 *  - a failed query is recorded as an error, never as "nothing found". The caller folds
 *    those errors into its verdict, so doubt can never become a pass.
 */

/**
 * @param {object} options
 * @param {(appPid: number, binMarker: string) => Promise<{ok: boolean, identities?: Array<{pid: number, creationMs: number|null}>, error?: string|null}>} options.discover
 * @param {number} options.appPid
 * @param {string} options.binMarker
 * @param {number} [options.intervalMs]
 */
export function createIdentityWatcher(options) {
  const {
    discover,
    appPid,
    binMarker,
    intervalMs = 250,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options
  const seen = new Map()
  const errors = []
  let stopped = false
  let timer = null
  let inFlight = null

  const remember = (identities) => {
    for (const identity of identities ?? []) {
      const key = identity.pid + ':' + identity.creationMs
      if (!seen.has(key)) seen.set(key, identity)
    }
  }

  const tick = async () => {
    try {
      const found = await discover(appPid, binMarker)
      if (!found || !found.ok) {
        errors.push(found && found.error ? found.error : 'discovery returned no result')
      } else {
        remember(found.identities)
      }
    } catch (error) {
      errors.push(String(error?.message ?? error))
    } finally {
      // `run` is a hoisted declaration, so scheduling the next tick is safe here.
      if (!stopped) timer = setTimeoutFn(run, intervalMs)
    }
  }

  function run() {
    inFlight = tick()
    return inFlight
  }

  run()

  return {
    /**
     * Stop polling and wait until the query already in flight has settled and been
     * recorded. Resolves with every distinct identity seen, including that last one.
     */
    async stop() {
      stopped = true
      if (timer !== null) {
        clearTimeoutFn(timer)
        timer = null
      }
      if (inFlight) await inFlight
      return [...seen.values()]
    },
    get identities() {
      return [...seen.values()]
    },
    get errors() {
      return [...errors]
    },
  }
}

/**
 * Verify every captured identity. Only ABSENT for all of them — with no watcher error at
 * all — counts as clean. A failed or unconfirmable query is doubt, and doubt is not
 * success.
 *
 * @param {Array<{pid: number, creationMs: number|null}>} identities
 * @param {(identity: any) => Promise<{status: string}>} verify
 * @param {string[]} [watchErrors]
 */
export async function verifyIdentities(identities, verify, watchErrors = []) {
  const checks = []
  for (const identity of identities ?? []) {
    checks.push({ identity, verdict: await verify(identity) })
  }
  return {
    count: checks.length,
    checks,
    statuses: checks.map((entry) => entry.verdict.status),
    watchErrors: [...watchErrors],
    allGone: checks.length > 0 && watchErrors.length === 0 && checks.every((entry) => entry.verdict.status === 'ABSENT'),
  }
}
