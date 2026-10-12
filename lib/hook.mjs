/**
 * hook.mjs — the automatic screener on `tools/post-execute`.
 *
 * Why this event and not `tools/execute`: DSH documents `tools/post-execute` as
 * "accept, replace, enrich, or block a normalized dispatch result", and content
 * replacement is explicitly *presentation policy, not confidentiality policy* —
 * the canonical `value` is preserved. That is exactly the semantics a context
 * screen needs: the model reads less, while the programmatic result stays whole
 * and the removal is reversible.
 *
 * Two failure rules, both chosen so the plugin can never make things worse:
 *  - A service outage does NOT block a result that actually succeeded. The text
 *    is annotated as unscreened and passed through. (Blocking would turn "the
 *    screen is down" into "your working tool call failed".)
 *  - A failed screen never drops anything. Only a `screened` verdict replaces
 *    content.
 */
import { toolMatches } from './config.mjs'
import { runScreen } from './screen-runner.mjs'
import { SCREEN_DECISIONS } from './constants.mjs'

/** Concatenate the model-facing text of a content block array. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n')
}

/** Replace the text blocks of a copy, leaving non-text blocks untouched. */
export function replaceTextContent(content, replacement) {
  if (!Array.isArray(content)) return [{ type: 'text', text: replacement }]
  const out = []
  let placed = false
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      if (!placed) {
        out.push({ ...block, text: replacement })
        placed = true
      }
      continue
    }
    out.push(block)
  }
  if (!placed) out.unshift({ type: 'text', text: replacement })
  return out
}

/**
 * Build the `tools/post-execute` listener.
 *
 * @param {object} config - resolved config (config.hook holds the hook settings)
 * @param {object} [logger]
 * @param {object} [deps] - injectable fetch, for tests
 * @returns listener with the documented `(exec, result, next)` signature
 */
export function createPostExecuteScreen(config, logger, deps = {}) {
  const stats = { considered: 0, screened: 0, passedThrough: 0, degraded: 0, charsBefore: 0,
    charsAfter: 0 }

  const listener = async function postExecuteScreen(exec, result, next) {
    // A host that invokes the listener without next() would otherwise get a
    // TypeError thrown out of the waterfall and abort the pipeline. Degrade to
    // accepting the result untouched instead.
    if (typeof next !== 'function') {
      logger?.warn?.(
        'phocinae-screen: post-execute listener invoked without next(); '
        + 'returning the result unscreened rather than breaking the pipeline',
      )
      return { kind: 'accept' }
    }

    if (!config.hook.enabled) return next()

    const toolName = exec && typeof exec.name === 'string' ? exec.name : ''
    if (!toolMatches(config.hook.tools, toolName)) return next()

    // Only a successful result with text has anything worth screening.
    if (!result || result.isError === true || !Array.isArray(result.content)) return next()

    const contentText = textOfContent(result.content)
    if (contentText.length < config.hook.minChars) return next()

    stats.considered += 1
    let outcome
    try {
      outcome = await runScreen(contentText, config, deps)
    } catch (err) {
      // runScreen is written not to throw for service issues; anything reaching
      // here is a bug in this plugin, and a bug must not lose the result.
      logger?.warn?.(
        `phocinae-screen: screening threw (${err && err.message ? err.message : String(err)}); `
        + 'result passed through unchanged',
      )
      stats.degraded += 1
      return next()
    }

    if (outcome.decision !== SCREEN_DECISIONS.screened) {
      stats.passedThrough += 1
      if (outcome.degraded) {
        stats.degraded += 1
        const note = `[phocinae-screen] not screened: ${outcome.reason}. `
          + `The text below is the raw tool output (${outcome.totalChars} chars).`
        if (config.audit) logger?.info?.(`phocinae-screen: degraded — ${outcome.reason}`)
        return { kind: 'accept', content: replaceTextContent(result.content, `${note}\n\n${contentText}`) }
      }
      return next()
    }

    stats.screened += 1
    stats.charsBefore += outcome.totalChars
    stats.charsAfter += outcome.keptChars
    if (config.audit) {
      logger?.info?.(
        `phocinae-screen: tool=${toolName} dropped=${outcome.dropped.length}/${outcome.blockCount} `
        + `chars ${outcome.totalChars}->${outcome.keptChars} in ${outcome.elapsedMs} ms`,
      )
    }

    // Content replacement only: `value` is preserved, so a caller reading the
    // programmatic result still sees everything.
    return { kind: 'accept', content: replaceTextContent(result.content, outcome.text) }
  }

  listener.stats = () => ({ ...stats })
  return listener
}
