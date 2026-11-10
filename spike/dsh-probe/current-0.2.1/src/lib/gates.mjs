/**
 * Overall verdict and exit code for the suite.
 *
 * Extracted from `run-all.mjs` so the rule can be tested directly: the claim "a leak
 * fails the run" has to be provable without running six model probes to observe it.
 *
 * The rule is deliberately blunt — a gate failure outranks any number of probe passes.
 * That is the whole point of a gate. BLOCKED is weaker than FAIL: it means the
 * environment could not answer, which is not the same as the code being wrong.
 */

export const EXIT = { PASS: 0, BLOCKED: 2, FAIL: 1 }

/**
 * @param {object} input
 * @param {number} [input.failed]      probes that returned FAIL
 * @param {number} [input.blocked]     probes that returned BLOCKED
 * @param {'PASS'|'FAIL'} [input.dependency] dependency gate status
 * @param {'PASS'|'FAIL'} [input.leak]       leak gate status
 */
export function decideOverall({ failed = 0, blocked = 0, dependency = 'PASS', leak = 'PASS' } = {}) {
  const gateFailures = (dependency === 'FAIL' ? 1 : 0) + (leak === 'FAIL' ? 1 : 0)
  const overall = failed + gateFailures > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS'
  return { overall, exitCode: EXIT[overall], gateFailures }
}
