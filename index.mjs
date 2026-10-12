/**
 * dsh-phocinae-screen — offline context screening for DeepSeek Harness.
 *
 * One idea: before a large tool result reaches the model's context, score every
 * block of it with the local 144.3M Phocinae decision model on the 2-10
 * relevance scale, and drop only the blocks that scored at or below the drop
 * threshold. Blocks in the uncertain middle band are kept and reported, and each
 * dropped block comes back as a digest, so the screen is auditable rather than
 * lossy.
 *
 * Two contributions:
 *  1. `phocinae_screen` / `phocinae_screen_stats` tools on `ctx.tools`.
 *  2. An optional `tools/post-execute` listener that screens large results
 *     automatically. It replaces model-facing **content** only; the canonical
 *     `value` is untouched, so nothing is actually thrown away.
 *
 * Mounting contract (same shape as dsh-phocinae, verified against a real host):
 *  - the post-execute listener is subscribed in the plugin body, so screening is
 *    armed the moment the entry activates;
 *  - tool registration waits for the `tools` service through `ctx.inject`, so the
 *    entry never reads an undeclared service name;
 *  - the plugin body throws only for configuration that cannot be honoured. A
 *    decision-service outage is never a load failure — it is a passthrough.
 */
import {
  DEFAULT_DROP_AT,
  DEFAULT_ENDPOINT,
  DEFAULT_KEEP_AT,
  DEFAULT_MAX_BATCH,
  DEFAULT_MIN_BLOCK_CHARS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  SCREEN_DECISIONS,
  SKILL_NAME,
  TOOL_NAMES,
} from './lib/constants.mjs'
import { ConfigError, resolveConfig, toolMatches } from './lib/config.mjs'
import { createPostExecuteScreen, textOfContent } from './lib/hook.mjs'
import { buildScreenRequest, decideScreen, digestBlock, readScore, readScoreConfidence,
  renderScreened, splitBlocks } from './lib/screen.mjs'
import { runScreen } from './lib/screen-runner.mjs'
import { batchEndpointFor, isLoopbackUrl, postBatch, scoreBlocks } from './lib/protocol.mjs'
import { createTools } from './tools.mjs'
import { createSkill } from './lib/skill.mjs'

export const PLUGIN_ID = 'phocinae-screen'
export const BUNDLE_NAME = 'dsh-phocinae-screen'

export const DEFAULTS = Object.freeze({
  endpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBatch: DEFAULT_MAX_BATCH,
  minBlockChars: DEFAULT_MIN_BLOCK_CHARS,
  keepAt: DEFAULT_KEEP_AT,
  dropAt: DEFAULT_DROP_AT,
})

export {
  ConfigError,
  ERROR_CODES,
  SCREEN_DECISIONS,
  SKILL_NAME,
  TOOL_NAMES,
  batchEndpointFor,
  buildScreenRequest,
  createPostExecuteScreen,
  createSkill,
  createTools,
  decideScreen,
  digestBlock,
  isLoopbackUrl,
  postBatch,
  readScore,
  readScoreConfidence,
  renderScreened,
  resolveConfig,
  runScreen,
  scoreBlocks,
  splitBlocks,
  textOfContent,
  toolMatches,
}

/**
 * Apply the plugin to a context.
 *
 * @param ctx - plugin context. `ctx.on` arms the hook; `ctx.tools` (reached
 *   through `ctx.inject`) registers the tools when the harness composes a
 *   registry.
 * @param rawConfig - deployment configuration, already merged by the loader
 * @returns the plugin descriptor, for diagnostics and tests
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig ?? {})
  const logger = ctx?.logger

  const tools = createTools(config, logger)

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      for (const definition of tools) toolCtx.tools.register(definition)
    })
    ctx.inject(['skills'], (skillCtx) => {
      try {
        skillCtx.skills.register(createSkill())
      } catch (err) {
        logger?.warn?.(
          `phocinae-screen: skill registration failed (${err && err.message ? err.message : err})`,
        )
      }
    })
  } else if (ctx?.tools && typeof ctx.tools.register === 'function') {
    // Already scoped to the registry (tests, or a host that hands it in
    // directly). No probe of undeclared names, so this cannot throw.
    for (const definition of tools) ctx.tools.register(definition)
    if (ctx.skills && typeof ctx.skills.register === 'function') {
      try {
        ctx.skills.register(createSkill())
      } catch (err) {
        logger?.warn?.(`phocinae-screen: skill registration failed (${err && err.message})`)
      }
    }
  } else if (logger) {
    logger.warn?.(
      'phocinae-screen: no tool registry on this context — the post-execute screen is '
      + 'active, but phocinae_screen / phocinae_screen_stats are not registered',
    )
  }

  let screenListener = null
  if (typeof ctx?.on === 'function') {
    screenListener = createPostExecuteScreen(config, logger)
    ctx.on('tools/post-execute', screenListener)
  } else if (logger) {
    logger.warn?.('phocinae-screen: context has no event bus — automatic screening is inactive')
  }

  return Object.freeze({
    id: PLUGIN_ID,
    bundle: BUNDLE_NAME,
    tools: TOOL_NAMES,
    skill: SKILL_NAME,
    hookEnabled: config.hook.enabled,
    config,
    screenListener,
  })
}

export default apply
