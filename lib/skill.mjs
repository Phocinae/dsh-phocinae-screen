/**
 * skill.mjs — the `phocinae-screen` skill.
 *
 * Teaching text only: the tools work without it, and the automatic hook does too.
 * A host with a skill registry gets this in-context so a model does not have to
 * discover the thresholds by trial and error.
 */
import { SKILL_NAME } from './constants.mjs'

const BODY = `# phocinae-screen — offline context screening

Use \`phocinae_screen\` to shrink a large block of text before reading it in
full, and rely on the automatic \`tools/post-execute\` listener to do the same
for large tool results when it is armed.

## When to use it

- A tool returned far more text than the task needs (a whole build log, a long
  file listing, a large search dump) and you only need the part that matters.
- You are assembling context and want to drop boilerplate before it spends
  tokens in a large model.
- A result repeats itself, or is mostly an error trace unrelated to the task.

## When not to use it

- The text is short. Blocks under \`minBlockChars\` are never dropped anyway, so a
  call is wasted work.
- You need every line: a diff you are about to apply, a file whose exact bytes
  matter, a contract or licence. Screening removes text by design.
- You want a summary. This is not a summariser — it removes and reports, it does
  not paraphrase. Use a generative model for that.

## How to read the result

- \`decision: "screened"\` — something was dropped. \`digest\` lists every dropped
  block with its offset, size, score and first ~96 characters, so you can go back
  to the original output for any of them.
- \`decision: "passthrough"\` — nothing qualified; you have the full text.
- \`decision: "refused"\` — the drop guards tripped (a screen that would remove
  more than \`maxDropRatio\` of blocks, or \`maxDropCharsRatio\` of characters). The
  input is returned whole. A refusal usually means the thresholds do not fit this
  content, not that the content is unusual.
- \`degraded: true\` — the local decision service did not answer, so nothing was
  scored and everything was kept. Check the service, then retry if it matters.

## What makes the screen safe to trust

- The uncertain middle band (\`dropAt\` < score < \`keepAt\`) is **kept** and flagged
  in \`uncertain\`. The 150M model is not calibrated for every domain, so dropping
  on an uncalibrated boundary is exactly the mistake this avoids.
- A block that could not be scored is kept, not assumed irrelevant.
- The automatic hook replaces the model-facing content only; the tool result's
  canonical value is untouched, so a programmatic reader still sees everything.
`

export function createSkill() {
  return {
    name: SKILL_NAME,
    description:
      'Screen large text with the local Phocinae decision model before it reaches the '
      + 'context: score every block on 2-10 relevance, drop only the clear misses, and '
      + 'report every removal as a digest. Offline, batched, auditable.',
    body: BODY,
  }
}
