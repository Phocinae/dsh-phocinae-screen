/**
 * protocol.mjs — a minimal client for the Phocinae `systemone` contract.
 *
 * Deliberately smaller than the one in dsh-phocinae: this plugin only needs the
 * batch endpoint and per-block scores, so it carries no permissions or gate
 * machinery. Two properties matter more than completeness:
 *
 *  1. **Loopback by default.** Screening states carry raw tool output, which is
 *     the most sensitive text in a session. A non-loopback endpoint is a load
 *     error unless `allowRemoteEndpoint` was set on purpose.
 *  2. **No unbounded work.** Blocks are cut to `maxBatch`, and a failed batch
 *     degrades to "screen nothing" rather than to a partial result that would
 *     read as if the unscreened remainder had been judged.
 */
import { DEFAULT_MAX_BATCH, DEFAULT_TIMEOUT_MS } from './constants.mjs'

/** True when the URL points at this machine. */
export function isLoopbackUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  if (host.endsWith('.localhost')) return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  const m = /^172\.(\d{1,3})\./.exec(host)
  if (m) {
    const octet = Number(m[1])
    if (octet >= 16 && octet <= 31) return true
  }
  return false
}

/** The batch endpoint that belongs to a given systemone endpoint. */
export function batchEndpointFor(endpoint) {
  const base = String(endpoint || '').replace(/\/+$/, '')
  if (base.endsWith('/batch')) return base
  return `${base}/batch`
}

/**
 * POST one chunk to `/v1/systemone/batch`.
 *
 * @returns {Promise<{ ok: true, items: unknown[] } | { ok: false, reason: string }>}
 */
export async function postBatch(endpoint, requests, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'no fetch implementation available' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(batchEndpointFor(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await safeText(res)
      return { ok: false, reason: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` }
    }
    const data = await res.json().catch(() => null)
    if (!Array.isArray(data)) {
      return { ok: false, reason: 'batch response is not a JSON array' }
    }
    return { ok: true, items: data }
  } catch (err) {
    const name = err && err.name ? err.name : 'Error'
    const reason = name === 'AbortError'
      ? `timed out after ${timeoutMs} ms`
      : `${name}: ${err && err.message ? err.message : String(err)}`
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * Score every block, chunked to `maxBatch`.
 *
 * Returns a Map of block id -> score, plus a `failed` list naming the chunks
 * that did not answer. A failed chunk is reported, never silently treated as
 * "scored zero": the caller decides whether a partial screen is acceptable.
 */
export async function scoreBlocks(blocks, opts = {}) {
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH
  const byId = new Map()
  const failures = []
  let scored = 0

  for (let i = 0; i < blocks.length; i += maxBatch) {
    const chunk = blocks.slice(i, i + maxBatch)
    const requests = opts.buildRequest(chunk)
    const res = await postBatch(opts.endpoint, requests, opts)
    if (!res.ok) {
      failures.push({ from: i, count: chunk.length, reason: res.reason })
      continue
    }
    if (res.items.length !== chunk.length) {
      failures.push({
        from: i,
        count: chunk.length,
        reason: `asked for ${chunk.length} scores, got ${res.items.length}`,
      })
      continue
    }
    chunk.forEach((block, idx) => {
      const score = opts.readScore(res.items[idx])
      if (score === null) {
        failures.push({ from: i + idx, count: 1, reason: 'response carried no score' })
        return
      }
      byId.set(block.id, score)
      const conf = opts.readConfidence ? opts.readConfidence(res.items[idx]) : undefined
      if (typeof conf === 'number') byId.set(`${block.id}:confidence`, conf)
      scored += 1
    })
  }

  return { scores: byId, failures, scored }
}
