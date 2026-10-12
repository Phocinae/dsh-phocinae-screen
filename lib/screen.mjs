/**
 * screen.mjs — the screening core: split context into blocks, score them,
 * decide what to keep, and describe the decision honestly.
 *
 * Design rule that shapes everything here: **a screen may only drop what it can
 * prove it may drop.** The 150M model is not calibrated for every domain, so an
 * uncertain middle band is KEPT and flagged rather than dropped. The caller
 * always receives the dropped blocks' digests, so nothing vanishes silently.
 */
import {
  DEFAULT_DROP_AT,
  DEFAULT_KEEP_AT,
  DEFAULT_MAX_DROP_CHARS_RATIO,
  DEFAULT_MAX_DROP_RATIO,
  DEFAULT_MIN_BLOCK_CHARS,
  SCREEN_DECISIONS,
  SCREEN_QUESTION_ID,
} from './constants.mjs'

/**
 * Split text into screenable blocks.
 *
 * Strategy: prefer paragraph boundaries, then fall back to hard character
 * slicing for a single oversized paragraph. Each block keeps its offset so the
 * caller can map a kept block straight back to the original text without any
 * reconstruction guesswork.
 *
 * @param {string} text
 * @param {{ maxBlockChars?: number, minBlockChars?: number }} [opts]
 * @returns {Array<{ id: string, text: string, start: number, end: number }>}
 */
export function splitBlocks(text, opts = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const maxBlockChars = Number.isFinite(opts.maxBlockChars) && opts.maxBlockChars > 0
    ? Math.floor(opts.maxBlockChars)
    : 4000
  if (!source.trim()) return []

  const blocks = []
  const paragraphs = []
  let cursor = 0
  // Split on blank lines while remembering where each piece started.
  const re = /\n[ \t]*\n/g
  let m
  let last = 0
  while ((m = re.exec(source)) !== null) {
    paragraphs.push([last, m.index])
    last = m.index + m[0].length
  }
  paragraphs.push([last, source.length])

  for (const [from, to] of paragraphs) {
    const piece = source.slice(from, to)
    if (!piece.trim()) {
      cursor = to
      continue
    }
    if (piece.length <= maxBlockChars) {
      blocks.push({ start: from, end: to, text: piece })
    } else {
      // A single paragraph larger than the cap: slice it on the cap so a
      // pathological input still gets screened instead of skipped wholesale.
      for (let off = 0; off < piece.length; off += maxBlockChars) {
        const end = Math.min(off + maxBlockChars, piece.length)
        blocks.push({ start: from + off, end: from + end, text: piece.slice(off, end) })
      }
    }
    cursor = to
  }
  void cursor

  return blocks.map((b, i) => ({
    id: `b${String(i).padStart(3, '0')}`,
    text: b.text,
    start: b.start,
    end: b.end,
  }))
}

/**
 * Build the batch request body for a set of blocks.
 *
 * One `score` question per block: "how much does this carry that the task
 * needs?" on the model's 2–10 ordinal scale. The question is phrased the same
 * way for every block so the scores are comparable; only the state changes.
 */
export function buildScreenRequest(blocks, model) {
  return blocks.map((b) => ({
    model,
    state: b.text,
    questions: [
      {
        id: SCREEN_QUESTION_ID,
        type: 'score',
        instructions:
          'Rate how much unique, task-relevant information this block carries. '
          + '2 = boilerplate, a duplicate, or an error trace with no bearing on the task; '
          + '10 = the block answers a question the task explicitly asks.',
      },
    ],
  }))
}

/** Read `answers[SCREEN_QUESTION_ID]` out of one batch response item. */
export function readScore(item) {
  if (!item || typeof item !== 'object') return null
  const answers = item.answers
  if (!answers || typeof answers !== 'object') return null
  const value = answers[SCREEN_QUESTION_ID]
  return Number.isInteger(value) ? value : null
}

/** Read `answer_confidence[SCREEN_QUESTION_ID]` when the server sends extensions. */
export function readScoreConfidence(item) {
  const conf = item && typeof item === 'object' ? item.answer_confidence : null
  if (!conf || typeof conf !== 'object') return undefined
  const value = conf[SCREEN_QUESTION_ID]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Decide what to keep from scored blocks.
 *
 * @returns {{
 *   decision: string, keep: Array<object>, dropped: Array<object>,
 *   keptChars: number, droppedChars: number, totalChars: number,
 *   dropRatio: number, dropCharsRatio: number, refusedReason?: string
 * }}
 */
export function decideScreen(blocks, scores, opts = {}) {
  const keepAt = opts.keepAt ?? DEFAULT_KEEP_AT
  const dropAt = opts.dropAt ?? DEFAULT_DROP_AT
  const minBlockChars = opts.minBlockChars ?? DEFAULT_MIN_BLOCK_CHARS
  const maxDropRatio = opts.maxDropRatio ?? DEFAULT_MAX_DROP_RATIO
  const maxDropCharsRatio = opts.maxDropCharsRatio ?? DEFAULT_MAX_DROP_CHARS_RATIO

  const keep = []
  const dropped = []
  let keptChars = 0
  let droppedChars = 0
  let totalChars = 0

  for (const block of blocks) {
    const chars = block.text.length
    totalChars += chars
    const score = scores.get(block.id) ?? null
    const confidence = scores.get(`${block.id}:confidence`)

    // Too small to be worth a call, unscoreable, or confidently relevant.
    if (chars < minBlockChars) {
      keep.push({ ...block, score, confidence, reason: 'below_min_block_chars' })
      keptChars += chars
      continue
    }
    if (score === null) {
      // Unscored is not the same as irrelevant: keep it and say so.
      keep.push({ ...block, score: null, confidence, reason: 'unscored' })
      keptChars += chars
      continue
    }
    if (score >= keepAt) {
      keep.push({ ...block, score, confidence, reason: 'score_at_or_above_keep_at' })
      keptChars += chars
      continue
    }
    if (score <= dropAt) {
      dropped.push({ ...block, score, confidence, reason: 'score_at_or_below_drop_at' })
      droppedChars += chars
      continue
    }
    // The uncertain middle band is kept on purpose.
    keep.push({ ...block, score, confidence, uncertain: true, reason: 'between_drop_and_keep' })
    keptChars += chars
  }

  const dropRatio = blocks.length ? dropped.length / blocks.length : 0
  const dropCharsRatio = totalChars ? droppedChars / totalChars : 0

  if (dropRatio > maxDropRatio) {
    return {
      decision: SCREEN_DECISIONS.refused,
      keep: blocks.map((b) => ({ ...b, score: scores.get(b.id) ?? null,
        reason: 'refused_drop_ratio' })),
      dropped: [],
      keptChars: totalChars,
      droppedChars: 0,
      totalChars,
      dropRatio: 0,
      dropCharsRatio: 0,
      refusedReason:
        `screening would drop ${(dropRatio * 100).toFixed(0)}% of blocks, above the `
        + `${(maxDropRatio * 100).toFixed(0)}% guard; input passed through unscreened`,
    }
  }
  if (dropCharsRatio > maxDropCharsRatio) {
    return {
      decision: SCREEN_DECISIONS.refused,
      keep: blocks.map((b) => ({ ...b, score: scores.get(b.id) ?? null,
        reason: 'refused_drop_chars_ratio' })),
      dropped: [],
      keptChars: totalChars,
      droppedChars: 0,
      totalChars,
      dropRatio: 0,
      dropCharsRatio: 0,
      refusedReason:
        `screening would drop ${(dropCharsRatio * 100).toFixed(0)}% of characters, above `
        + `the ${(maxDropCharsRatio * 100).toFixed(0)}% guard; input passed through unscreened`,
    }
  }

  return {
    decision: dropped.length ? SCREEN_DECISIONS.screened : SCREEN_DECISIONS.passthrough,
    keep,
    dropped,
    keptChars,
    droppedChars,
    totalChars,
    dropRatio,
    dropCharsRatio,
  }
}

/**
 * A one-line digest of a dropped block: enough to recognise it, short enough to
 * keep cheap. This is what makes the screen auditable instead of lossy — the
 * caller can always see what was removed and where it came from.
 */
export function digestBlock(block, maxChars = 96) {
  const flat = block.text.replace(/\s+/g, ' ').trim()
  const head = flat.slice(0, maxChars)
  return {
    id: block.id,
    start: block.start,
    end: block.end,
    chars: block.text.length,
    score: block.score ?? null,
    confidence: block.confidence,
    head: flat.length > maxChars ? `${head}…` : head,
  }
}

/** Render the screened text plus a visible marker for every dropped block. */
export function renderScreened(kept, dropped) {
  const parts = kept.map((b) => b.text)
  if (dropped.length) {
    const lines = dropped.map((b) => {
      const d = digestBlock(b)
      return `- ${d.id} (chars ${d.chars}, score ${d.score ?? 'n/a'}): ${d.head}`
    })
    parts.push(
      `\n\n[phocinae-screen dropped ${dropped.length} block(s); recover them from the `
      + `original output if needed]\n${lines.join('\n')}`,
    )
  }
  return parts.join('\n\n')
}
