/**
 * constants.mjs — shipped defaults and frozen thresholds for dsh-phocinae-screen.
 *
 * Every threshold here was chosen against a measurement, and the measurement is
 * recorded next to it. If you change one, change its note too.
 */

/** Local Phocinae decision service. Loopback only, by the same rule as dsh-phocinae. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8155/v1/systemone'
export const DEFAULT_BATCH_ENDPOINT = 'http://127.0.0.1:8155/v1/systemone/batch'
export const DEFAULT_MODEL = 'Phocinae-Largha-150M-v1'

/**
 * Per-request timeout for screening. Measured on CPU (2026-10-11): a 30-block
 * batch completes in 0.50 s wall, i.e. 16.6 ms per block, so a 5 s ceiling
 * covers roughly a 300-block batch before it is worth splitting. GPU fp16 p50
 * is 21.0 ms for a single decision, so this ceiling is not the bottleneck.
 */
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * How many blocks one batch request may carry.
 *
 * The server caps a batch at 64 requests (MAX_BATCH in the client contract), so
 * this default is deliberately below that: leaving headroom keeps a single slow
 * block from pushing the whole batch past the timeout.
 */
export const DEFAULT_MAX_BATCH = 32

/** Blocks shorter than this are not worth a model call; they pass through. */
export const DEFAULT_MIN_BLOCK_CHARS = 200

/** score >= keepAt -> keep. The scale is 2–10 (ordinal), so 6 is the midpoint band. */
export const DEFAULT_KEEP_AT = 6

/**
 * score <= dropAt -> drop. Between dropAt and keepAt the block is KEPT and
 * flagged `uncertain`, because dropping on an uncalibrated middle band is how a
 * screen silently loses the one line that mattered.
 */
export const DEFAULT_DROP_AT = 3

/**
 * A screen that would drop more than this fraction of the input is refused and
 * the input passes through unscreened. Measured context-reduction claims are
 * around a third (S09 drops 11 of 30 blocks, 0.37), so 0.75 is well clear of
 * normal operation and only fires on a misconfiguration.
 */
export const DEFAULT_MAX_DROP_RATIO = 0.75

/**
 * A screen that would drop more than this fraction of the input's *characters*
 * is likewise refused: block count is a poor proxy for payload size, and the
 * whole point is to shrink what the model has to read.
 */
export const DEFAULT_MAX_DROP_CHARS_RATIO = 0.9

/** Question id used for the per-block relevance score. */
export const SCREEN_QUESTION_ID = 'keep'

/** Tool names this plugin contributes. */
export const TOOL_NAMES = Object.freeze(['phocinae_screen', 'phocinae_screen_stats'])

export const SKILL_NAME = 'phocinae-screen'

export const SCREEN_DECISIONS = Object.freeze({
  screened: 'screened',
  passthrough: 'passthrough',
  refused: 'refused',
})

export const ERROR_CODES = Object.freeze({
  badConfig: 'bad_config',
  badRequest: 'bad_request',
  unavailable: 'screening_service_unavailable',
  badResponse: 'screening_service_bad_response',
})
