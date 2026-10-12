/**
 * tools.mjs — the two tools this plugin contributes.
 *
 * Hand-built `ToolDefinition` objects, matching the schema facts the registry
 * enforces (verified against a real host by dsh-phocinae):
 *  - the model-facing field is `parameters` (raw JSON Schema), not `inputSchema`;
 *  - both `parameters` and `output.schema` must stay inside the harness's JSON
 *    Schema subset: one scalar `type` per node, `required` as an array of names,
 *    `oneOf` for unions, and no author-only keywords.
 */
import { runScreen } from './lib/screen-runner.mjs'
import { SCREEN_DECISIONS, TOOL_NAMES } from './lib/constants.mjs'

const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Block id, in input order.' },
    start: { type: 'number', description: 'Byte offset of the block in the input.' },
    end: { type: 'number', description: 'End offset of the block in the input.' },
    chars: { type: 'number', description: 'Block length in characters.' },
    score: NULLABLE_NUMBER,
    head: { type: 'string', description: 'First ~96 characters, for recognition.' },
  },
  required: ['id', 'start', 'end', 'chars', 'head'],
}

const SCREEN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description:
        'The text to screen: tool output, retrieved documents, or a context window that ' +
        'has grown too large to read in full. Split on blank lines into blocks.',
    },
    keepAt: {
      type: 'number',
      description:
        'Blocks scoring at or above this (2-10) are kept. Defaults to the configured value.',
    },
    dropAt: {
      type: 'number',
      description:
        'Blocks scoring at or below this are dropped. Scores between dropAt and keepAt are ' +
        'KEPT and marked uncertain, because the middle band is not calibrated.',
    },
  },
  required: ['text'],
}

const SCREEN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: {
      type: 'string',
      enum: ['screened', 'passthrough', 'refused'],
      description:
        'screened: something was dropped. passthrough: nothing qualified. refused: the drop ' +
        'guard tripped, so the input is returned whole.',
    },
    reason: { type: 'string', description: 'Why this decision was reached.' },
    screenedText: {
      type: 'string',
      description: 'The text with dropped blocks removed, plus a marker listing what went.',
    },
    blockCount: { type: 'number' },
    scored: { type: 'number', description: 'How many blocks the service actually scored.' },
    kept: { type: 'number' },
    dropped: { type: 'number' },
    keptChars: { type: 'number' },
    droppedChars: { type: 'number' },
    totalChars: { type: 'number' },
    dropRatio: { type: 'number' },
    digest: {
      type: 'array',
      items: DIGEST_SCHEMA,
      description: 'One entry per dropped block, so the removal is auditable.',
    },
    uncertain: {
      type: 'array',
      items: DIGEST_SCHEMA,
      description: 'Kept blocks whose score landed in the uncertain band.',
    },
    degraded: {
      type: 'boolean',
      description: 'True when the screening service did not answer and the input passed through.',
    },
    elapsedMs: { type: 'number' },
  },
  required: ['decision', 'reason', 'screenedText', 'blockCount', 'scored', 'kept', 'dropped',
    'totalChars', 'dropRatio', 'degraded', 'elapsedMs'],
}

const STATS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    probe: {
      type: 'boolean',
      description:
        'When true, send one small scoring request to confirm the screening service answers.',
    },
  },
}

const STATS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    endpoint: { type: 'string' },
    model: { type: 'string' },
    hookEnabled: { type: 'boolean' },
    hookTools: { type: 'array', items: { type: 'string' } },
    hookMinChars: { type: 'number' },
    keepAt: { type: 'number' },
    dropAt: { type: 'number' },
    maxDropRatio: { type: 'number' },
    maxBatch: { type: 'number' },
    reachable: { type: 'boolean' },
    probeResult: { type: 'string' },
  },
  required: ['endpoint', 'model', 'hookEnabled', 'keepAt', 'dropAt', 'reachable', 'probeResult'],
}

function showNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a'
}

/**
 * @param {object} config - resolved config
 * @param {object} [logger]
 * @param {object} [deps] - injectable fetch for tests
 */
export function createTools(config, logger, deps = {}) {
  const screenTool = {
    name: TOOL_NAMES[0],
    description:
      'Shrink a large piece of text — tool output, retrieved documents, a long context — by ' +
      'scoring every block with the local Phocinae decision model (Phocinae-Largha-150M-v1) ' +
      'on the 2-10 relevance scale, then dropping only the blocks that scored at or below the ' +
      'drop threshold. Runs entirely on your machine, one batched forward pass per 32 blocks. ' +
      'Blocks in the uncertain middle band are KEPT and reported, and every dropped block ' +
      'comes back as a digest so the removal is auditable rather than silent. Use it before ' +
      'reading a very large tool result in full. Do not use it to summarise or rewrite text: ' +
      'it removes and reports, it does not paraphrase.',
    parameters: SCREEN_PARAMETERS,
    output: {
      schema: SCREEN_OUTPUT_SCHEMA,
      render(_args, value) {
        const pct = value.totalChars
          ? Math.round((1 - (value.keptChars + 0) / value.totalChars) * 100)
          : 0
        const head = value.degraded
          ? `phocinae-screen: screening service unavailable, text passed through unchanged (${value.reason}).`
          : value.decision === SCREEN_DECISIONS.refused
            ? `phocinae-screen: refused to screen — ${value.reason}`
            : value.dropped
              ? `phocinae-screen: dropped ${value.dropped} of ${value.blockCount} block(s) `
                + `(~${pct}% of characters), kept ${value.kept} (${value.uncertain.length} uncertain). `
                + `Scored in ${value.elapsedMs} ms.`
              : `phocinae-screen: nothing qualified for removal; all ${value.blockCount} block(s) kept.`
        return [{ type: 'text', text: `${head}\n\n${value.screenedText}` }]
      },
    },
    async execute(args) {
      const result = await runScreen(args.text, {
        ...config,
        keepAt: typeof args.keepAt === 'number' ? args.keepAt : config.keepAt,
        dropAt: typeof args.dropAt === 'number' ? args.dropAt : config.dropAt,
      }, deps)
      if (config.audit && logger) {
        logger.info?.(
          `phocinae-screen: decision=${result.decision} blocks=${result.blockCount} `
          + `dropped=${result.dropped.length} ms=${result.elapsedMs}`,
        )
      }
      return {
        decision: result.decision,
        reason: result.reason,
        screenedText: result.decision === SCREEN_DECISIONS.refused
          ? result.text ?? ''
          : result.text ?? '',
        blockCount: result.blockCount,
        scored: result.scored ?? 0,
        kept: result.keep.length,
        dropped: result.dropped.length,
        keptChars: result.keptChars,
        droppedChars: result.droppedChars,
        totalChars: result.totalChars,
        dropRatio: Number.isFinite(result.dropRatio) ? result.dropRatio : 0,
        digest: result.digests ?? [],
        uncertain: result.uncertain ?? [],
        degraded: Boolean(result.degraded),
        elapsedMs: result.elapsedMs,
      }
    },
  }

  const statsTool = {
    name: TOOL_NAMES[1],
    description:
      'Report the phocinae-screen configuration that is actually in effect — endpoint, ' +
      'thresholds, drop guards, and whether the automatic post-execute hook is armed — and ' +
      'optionally probe the local decision service. Use it to confirm why a screen did or did ' +
      'not happen before assuming the plugin is broken.',
    parameters: STATS_PARAMETERS,
    output: {
      schema: STATS_OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [
          `endpoint      : ${value.endpoint}`,
          `model         : ${value.model}`,
          `keepAt / dropAt: ${value.keepAt} / ${value.dropAt}`,
          `maxDropRatio  : ${value.maxDropRatio}`,
          `maxBatch      : ${value.maxBatch}`,
          `hook          : ${value.hookEnabled ? 'armed' : 'off'}` +
            (value.hookEnabled ? ` (tools: ${value.hookTools.join(', ')}, minChars ${value.hookMinChars})` : ''),
          `service       : ${value.probeResult}`,
        ]
        return [{ type: 'text', text: `phocinae-screen configuration\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const wantsProbe = args && args.probe === true
      let reachable = false
      let probeResult = 'not probed'
      if (wantsProbe) {
        const probe = await runScreen('probe block\n\nprobe block two', {
          ...config,
          minBlockChars: 0,
        }, deps)
        reachable = !probe.degraded
        probeResult = probe.degraded
          ? `unreachable (${probe.reason})`
          : `reachable — scored ${probe.scored} probe block(s) in ${probe.elapsedMs} ms`
      }
      return {
        endpoint: config.batchEndpoint,
        model: config.model,
        hookEnabled: config.hook.enabled,
        hookTools: [...config.hook.tools],
        hookMinChars: config.hook.minChars,
        keepAt: config.keepAt,
        dropAt: config.dropAt,
        maxDropRatio: config.maxDropRatio,
        maxBatch: config.maxBatch,
        reachable,
        probeResult,
      }
    },
  }

  return [screenTool, statsTool]
}

export { showNumber }
