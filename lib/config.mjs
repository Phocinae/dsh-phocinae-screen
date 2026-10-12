/**
 * config.mjs — configuration resolution.
 *
 * Two rules, both learned from the sibling plugin's bug history:
 *  1. Every key has a documented default, so a deployment can shrink to
 *     `enabled: true` and still work.
 *  2. Illegal values throw at load time. Silently defaulting a mistyped
 *     threshold is how a screen ends up dropping something it should have kept.
 */
import {
  DEFAULT_BATCH_ENDPOINT,
  DEFAULT_DROP_AT,
  DEFAULT_ENDPOINT,
  DEFAULT_KEEP_AT,
  DEFAULT_MAX_BATCH,
  DEFAULT_MAX_DROP_CHARS_RATIO,
  DEFAULT_MAX_DROP_RATIO,
  DEFAULT_MIN_BLOCK_CHARS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
} from './constants.mjs'
import { batchEndpointFor, isLoopbackUrl } from './protocol.mjs'

export class ConfigError extends Error {
  constructor(message, code = ERROR_CODES.badConfig) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

function requireNumber(value, name, { min, max, integer }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${name} must be a finite number, got ${JSON.stringify(value)}`)
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, got ${value}`)
  }
  if (min !== undefined && value < min) {
    throw new ConfigError(`${name} must be >= ${min}, got ${value}`)
  }
  if (max !== undefined && value > max) {
    throw new ConfigError(`${name} must be <= ${max}, got ${value}`)
  }
  return value
}

function optionalNumber(value, name, bounds, fallback) {
  if (value === undefined || value === null) return fallback
  return requireNumber(value, name, bounds)
}

/**
 * Resolve raw deployment configuration into a complete, validated config.
 *
 * @throws {ConfigError} for anything that cannot be honoured as written.
 */
export function resolveConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {}

  const endpoint = cfg.endpoint === undefined || cfg.endpoint === null
    ? DEFAULT_ENDPOINT
    : String(cfg.endpoint)
  if (!endpoint.trim()) {
    throw new ConfigError('endpoint must not be empty')
  }
  const allowRemoteEndpoint = cfg.allowRemoteEndpoint === true
  if (!allowRemoteEndpoint && !isLoopbackUrl(endpoint)) {
    throw new ConfigError(
      `endpoint ${endpoint} is not loopback. Screening states carry raw tool output, `
      + 'so a remote endpoint must be opted into explicitly with allowRemoteEndpoint: true',
    )
  }

  const keepAt = optionalNumber(cfg.keepAt, 'keepAt', { min: 2, max: 10, integer: true },
    DEFAULT_KEEP_AT)
  const dropAt = optionalNumber(cfg.dropAt, 'dropAt', { min: 2, max: 10, integer: true },
    DEFAULT_DROP_AT)
  if (dropAt >= keepAt) {
    throw new ConfigError(
      `dropAt (${dropAt}) must be strictly below keepAt (${keepAt}); otherwise the `
      + 'uncertain band is empty and the screen drops on an uncalibrated boundary',
    )
  }

  const maxDropRatio = optionalNumber(cfg.maxDropRatio, 'maxDropRatio',
    { min: 0, max: 1 }, DEFAULT_MAX_DROP_RATIO)
  const maxDropCharsRatio = optionalNumber(cfg.maxDropCharsRatio, 'maxDropCharsRatio',
    { min: 0, max: 1 }, DEFAULT_MAX_DROP_CHARS_RATIO)

  const hook = cfg.hook && typeof cfg.hook === 'object' ? cfg.hook : {}
  const tools = Array.isArray(hook.tools) ? hook.tools.map(String) : ['*']

  return Object.freeze({
    endpoint,
    batchEndpoint: batchEndpointFor(endpoint),
    allowRemoteEndpoint,
    model: cfg.model === undefined || cfg.model === null ? DEFAULT_MODEL : String(cfg.model),
    timeoutMs: optionalNumber(cfg.timeoutMs, 'timeoutMs', { min: 50 }, DEFAULT_TIMEOUT_MS),
    maxBatch: optionalNumber(cfg.maxBatch, 'maxBatch',
      { min: 1, max: 64, integer: true }, DEFAULT_MAX_BATCH),
    maxBlockChars: optionalNumber(cfg.maxBlockChars, 'maxBlockChars',
      { min: 200, integer: true }, 4000),
    minBlockChars: optionalNumber(cfg.minBlockChars, 'minBlockChars',
      { min: 0, integer: true }, DEFAULT_MIN_BLOCK_CHARS),
    keepAt,
    dropAt,
    maxDropRatio,
    maxDropCharsRatio,
    hook: Object.freeze({
      enabled: hook.enabled === true,
      tools: Object.freeze(tools),
      minChars: optionalNumber(hook.minChars, 'hook.minChars',
        { min: 0, integer: true }, 8000),
      failMode: hook.failMode === 'open' ? 'open' : 'closed',
    }),
    audit: cfg.audit !== false,
    _batchEndpointDefault: DEFAULT_BATCH_ENDPOINT,
  })
}

/** Match a tool name against an exact name, a `prefix*` wildcard, or `*`. */
export function toolMatches(patterns, name) {
  const target = typeof name === 'string' ? name : ''
  if (!target) return false
  for (const pattern of patterns || []) {
    const p = String(pattern)
    if (p === '*') return true
    if (p.endsWith('*')) {
      if (target.startsWith(p.slice(0, -1))) return true
      continue
    }
    if (p === target) return true
  }
  return false
}
