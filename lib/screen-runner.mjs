/**
 * screen-runner.mjs — one place that performs a screen: split, score, decide.
 *
 * Both surfaces (the `phocinae_screen` tool and the `tools/post-execute` hook)
 * go through here, so a hook-screened result and a tool-screened result can
 * never drift apart in threshold handling or in what they report.
 */
import {
  DEFAULT_DROP_AT,
  DEFAULT_KEEP_AT,
  DEFAULT_MAX_BATCH,
  DEFAULT_MAX_DROP_CHARS_RATIO,
  DEFAULT_MAX_DROP_RATIO,
  DEFAULT_MIN_BLOCK_CHARS,
  DEFAULT_TIMEOUT_MS,
  SCREEN_DECISIONS,
} from './constants.mjs'
import { buildScreenRequest, decideScreen, digestBlock, readScore,
  readScoreConfidence, renderScreened, splitBlocks } from './screen.mjs'
import { scoreBlocks } from './protocol.mjs'

/**
 * Screen one piece of text.
 *
 * @param {string} text
 * @param {object} config - resolved plugin config
 * @param {object} [deps] - injectable fetch, for tests
 * @returns {Promise<object>} a result object that never throws for a service
 *   outage: an outage degrades to `passthrough` with `degraded: true` and a
 *   reason, because losing a screen must never lose the content.
 */
export async function runScreen(text, config, deps = {}) {
  const started = Date.now()
  const source = typeof text === 'string' ? text : String(text ?? '')
  const blocks = splitBlocks(source, {
    maxBlockChars: config.maxBlockChars,
    minBlockChars: config.minBlockChars,
  })

  const base = {
    blockCount: blocks.length,
    totalChars: source.length,
  }

  if (blocks.length === 0) {
    return {
      ...base,
      decision: SCREEN_DECISIONS.passthrough,
      reason: 'nothing to screen',
      kept: [],
      dropped: [],
      keptChars: 0,
      droppedChars: 0,
      elapsedMs: Date.now() - started,
      degraded: false,
    }
  }

  const { scores, failures, scored } = await scoreBlocks(blocks, {
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBatch: config.maxBatch ?? DEFAULT_MAX_BATCH,
    buildRequest: (chunk) => buildScreenRequest(chunk, config.model),
    readScore,
    readConfidence: readScoreConfidence,
    fetchImpl: deps.fetchImpl,
  })

  // An outage (nothing scored) is a degradation, not a verdict. Report it and
  // hand the text back whole.
  if (scored === 0) {
    return {
      ...base,
      decision: SCREEN_DECISIONS.passthrough,
      reason: `screening service unavailable (${failures[0]?.reason ?? 'no scores returned'})`,
      kept: blocks.map((b) => ({ ...b, score: null, reason: 'unscored' })),
      dropped: [],
      keptChars: source.length,
      droppedChars: 0,
      elapsedMs: Date.now() - started,
      degraded: true,
      failures,
    }
  }

  const verdict = decideScreen(blocks, scores, {
    keepAt: config.keepAt ?? DEFAULT_KEEP_AT,
    dropAt: config.dropAt ?? DEFAULT_DROP_AT,
    minBlockChars: config.minBlockChars ?? DEFAULT_MIN_BLOCK_CHARS,
    maxDropRatio: config.maxDropRatio ?? DEFAULT_MAX_DROP_RATIO,
    maxDropCharsRatio: config.maxDropCharsRatio ?? DEFAULT_MAX_DROP_CHARS_RATIO,
  })

  return {
    ...base,
    ...verdict,
    text: verdict.decision === SCREEN_DECISIONS.refused
      ? source
      : renderScreened(verdict.keep, verdict.dropped),
    digests: verdict.dropped.map((b) => digestBlock(b)),
    uncertain: verdict.keep.filter((b) => b.uncertain).map((b) => digestBlock(b)),
    scored,
    elapsedMs: Date.now() - started,
    degraded: false,
    failures,
  }
}
