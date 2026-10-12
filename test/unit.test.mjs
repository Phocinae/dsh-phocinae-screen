/**
 * unit.test.mjs — offline tests for the screening core. No network.
 *
 * Run: node --test "test/*.test.mjs"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ConfigError,
  buildScreenRequest,
  decideScreen,
  digestBlock,
  isLoopbackUrl,
  readScore,
  readScoreConfidence,
  renderScreened,
  resolveConfig,
  splitBlocks,
  textOfContent,
  toolMatches,
} from '../index.mjs'
import { replaceTextContent } from '../lib/hook.mjs'
import { createPostExecuteScreen } from '../lib/hook.mjs'

// ------------------------------------------------------------------ config
test('resolveConfig returns complete defaults for an empty config', () => {
  const c = resolveConfig({})
  assert.equal(c.endpoint, 'http://127.0.0.1:8155/v1/systemone')
  assert.equal(c.batchEndpoint, 'http://127.0.0.1:8155/v1/systemone/batch')
  assert.equal(c.keepAt, 6)
  assert.equal(c.dropAt, 3)
  assert.equal(c.maxBatch, 32)
  assert.equal(c.hook.enabled, false, 'the hook must be off unless asked for')
  assert.equal(c.hook.failMode, 'closed')
})

test('resolveConfig rejects a non-loopback endpoint unless explicitly allowed', () => {
  assert.throws(() => resolveConfig({ endpoint: 'http://example.com/v1/systemone' }),
    (e) => e instanceof ConfigError && /not loopback/.test(e.message))
  const ok = resolveConfig({
    endpoint: 'http://example.com/v1/systemone',
    allowRemoteEndpoint: true,
  })
  assert.equal(ok.allowRemoteEndpoint, true)
})

test('resolveConfig rejects dropAt >= keepAt instead of silently fixing it', () => {
  assert.throws(() => resolveConfig({ keepAt: 4, dropAt: 4 }),
    (e) => e instanceof ConfigError && /strictly below/.test(e.message))
  assert.throws(() => resolveConfig({ keepAt: 3, dropAt: 5 }), ConfigError)
})

test('resolveConfig rejects out-of-band scores and non-integer scores', () => {
  assert.throws(() => resolveConfig({ keepAt: 11 }), ConfigError)
  assert.throws(() => resolveConfig({ dropAt: 1 }), ConfigError)
  assert.throws(() => resolveConfig({ keepAt: 6.5 }), ConfigError)
  assert.throws(() => resolveConfig({ maxBatch: 65 }), ConfigError)
})

test('resolveConfig rejects ratios outside [0, 1]', () => {
  assert.throws(() => resolveConfig({ maxDropRatio: 1.5 }), ConfigError)
  assert.throws(() => resolveConfig({ maxDropCharsRatio: -0.1 }), ConfigError)
})

test('toolMatches covers exact names, prefix wildcards and the catch-all', () => {
  assert.equal(toolMatches(['*'], 'anything'), true)
  assert.equal(toolMatches(['read_*'], 'read_file'), true)
  assert.equal(toolMatches(['read_*'], 'write_file'), false)
  assert.equal(toolMatches(['read_file'], 'read_file'), true)
  assert.equal(toolMatches(['read_file'], 'read_files'), false)
  assert.equal(toolMatches([], 'read_file'), false)
  assert.equal(toolMatches(['*'], ''), false, 'an empty name must not match the catch-all')
})

test('isLoopbackUrl accepts loopback and private ranges, rejects the public internet', () => {
  for (const url of ['http://127.0.0.1:8155', 'http://localhost:1', 'http://[::1]:8155',
    'http://10.1.2.3:1', 'http://192.168.0.9:1', 'http://172.16.0.1:1',
    'http://172.31.255.254:1']) {
    assert.equal(isLoopbackUrl(url), true, url)
  }
  for (const url of ['https://example.com', 'http://8.8.8.8', 'http://172.32.0.1',
    'http://172.15.0.1', 'not a url', '']) {
    assert.equal(isLoopbackUrl(url), false, url)
  }
})

// ------------------------------------------------------------------ splitting
test('splitBlocks splits on blank lines and records offsets that index the original', () => {
  const text = 'first block\n\nsecond block\n\nthird block'
  const blocks = splitBlocks(text)
  assert.equal(blocks.length, 3)
  for (const b of blocks) {
    assert.equal(text.slice(b.start, b.end), b.text,
      'each block must be recoverable from its offsets')
  }
  assert.deepEqual(blocks.map((b) => b.id), ['b000', 'b001', 'b002'])
})

test('splitBlocks slices a single oversized paragraph instead of skipping it', () => {
  const text = 'x'.repeat(250)
  const blocks = splitBlocks(text, { maxBlockChars: 100 })
  assert.equal(blocks.length, 3)
  assert.equal(blocks.reduce((n, b) => n + b.text.length, 0), 250)
  assert.equal(text.slice(blocks[1].start, blocks[1].end), blocks[1].text)
})

test('splitBlocks returns nothing for empty or whitespace-only input', () => {
  assert.deepEqual(splitBlocks(''), [])
  assert.deepEqual(splitBlocks('   \n\n  \n'), [])
})

test('buildScreenRequest emits one score question per block, phrased identically', () => {
  const blocks = splitBlocks('a\n\nb')
  const reqs = buildScreenRequest(blocks, 'm')
  assert.equal(reqs.length, 2)
  assert.equal(reqs[0].questions[0].type, 'score')
  assert.equal(reqs[0].questions[0].instructions, reqs[1].questions[0].instructions,
    'the rubric must not vary between blocks or the scores are not comparable')
  assert.equal(reqs[0].model, 'm')
})

// ------------------------------------------------------------------ reading
test('readScore insists on an integer answer keyed by the question id', () => {
  assert.equal(readScore({ answers: { keep: 7 } }), 7)
  assert.equal(readScore({ answers: { keep: '7' } }), null, 'strings are not scores')
  assert.equal(readScore({ answers: { other: 7 } }), null)
  assert.equal(readScore({ answers: {} }), null)
  assert.equal(readScore({}), null)
  assert.equal(readScore(null), null)
})

test('readScoreConfidence tolerates a server without extensions', () => {
  assert.equal(readScoreConfidence({ answer_confidence: { keep: 0.8 } }), 0.8)
  assert.equal(readScoreConfidence({}), undefined)
  assert.equal(readScoreConfidence({ answer_confidence: { keep: 'high' } }), undefined)
})

// ------------------------------------------------------------------ decision
function blockOf(id, chars, score) {
  return { id, text: 'y'.repeat(chars), start: 0, end: chars, score }
}

test('decideScreen drops only at or below dropAt and keeps at or above keepAt', () => {
  const blocks = [blockOf('a', 500, 2), blockOf('b', 500, 7), blockOf('c', 500, 10)]
  const scores = new Map([['a', 2], ['b', 7], ['c', 10]])
  const v = decideScreen(blocks, scores, { minBlockChars: 100 })
  assert.deepEqual(v.dropped.map((b) => b.id), ['a'])
  assert.deepEqual(v.keep.map((b) => b.id), ['b', 'c'])
  assert.equal(v.decision, 'screened')
})

test('decideScreen KEEPS the uncertain middle band and flags it', () => {
  const blocks = [blockOf('a', 500, 5)]
  const v = decideScreen(blocks, new Map([['a', 5]]), { minBlockChars: 100 })
  assert.equal(v.dropped.length, 0, 'the uncalibrated middle band must not be dropped')
  assert.equal(v.keep[0].uncertain, true)
  assert.equal(v.decision, 'passthrough')
})

test('decideScreen keeps a block that could not be scored', () => {
  const blocks = [blockOf('a', 500, undefined)]
  const v = decideScreen(blocks, new Map(), { minBlockChars: 100 })
  assert.equal(v.dropped.length, 0)
  assert.equal(v.keep[0].reason, 'unscored')
})

test('decideScreen never drops a block below minBlockChars even at the lowest score', () => {
  const blocks = [blockOf('a', 50, 2)]
  const v = decideScreen(blocks, new Map([['a', 2]]), { minBlockChars: 100 })
  assert.equal(v.dropped.length, 0)
  assert.equal(v.keep[0].reason, 'below_min_block_chars')
})

test('decideScreen refuses and returns everything when the block drop guard trips', () => {
  const blocks = [blockOf('a', 500, 2), blockOf('b', 500, 2), blockOf('c', 500, 2)]
  const scores = new Map([['a', 2], ['b', 2], ['c', 2]])
  const v = decideScreen(blocks, scores, { minBlockChars: 100, maxDropRatio: 0.5 })
  assert.equal(v.decision, 'refused')
  assert.equal(v.dropped.length, 0)
  assert.equal(v.keep.length, 3)
  assert.match(v.refusedReason, /above the 50% guard/)
})

test('decideScreen refuses when the character drop guard trips even if few blocks go', () => {
  const blocks = [blockOf('big', 10000, 2), blockOf('small', 100, 10)]
  const scores = new Map([['big', 2], ['small', 10]])
  const v = decideScreen(blocks, scores, { minBlockChars: 50, maxDropCharsRatio: 0.5 })
  assert.equal(v.decision, 'refused')
  assert.equal(v.dropped.length, 0)
})

test('decideScreen reports passthrough when nothing qualifies for removal', () => {
  const blocks = [blockOf('a', 500, 9)]
  const v = decideScreen(blocks, new Map([['a', 9]]), { minBlockChars: 100 })
  assert.equal(v.decision, 'passthrough')
  assert.equal(v.dropped.length, 0)
})

// ------------------------------------------------------------------ rendering
test('digestBlock flattens whitespace and truncates the head with a marker', () => {
  const d = digestBlock({ id: 'b0', text: 'a\n\n  b   c', start: 3, end: 40, score: 2 })
  assert.equal(d.head, 'a b c')
  assert.equal(d.chars, 'a\n\n  b   c'.length)
  const long = digestBlock({ id: 'b1', text: 'z'.repeat(200), start: 0, end: 200, score: 1 })
  assert.equal(long.head.length, 97, '96 characters plus the ellipsis')
  assert.ok(long.head.endsWith('…'))
})

test('renderScreened keeps kept text and lists every dropped block', () => {
  const kept = [{ id: 'b1', text: 'KEPT', start: 0, end: 4, score: 9 }]
  const dropped = [{ id: 'b0', text: 'DROPPED CONTENT', start: 10, end: 25, score: 2 }]
  const out = renderScreened(kept, dropped)
  assert.ok(out.includes('KEPT'))
  assert.ok(out.includes('b0'))
  assert.ok(out.includes('DROPPED CONTENT'), 'the digest must let the reader recognise it')
  assert.ok(/dropped 1 block/.test(out))
})

// ------------------------------------------------------------------ hook plumbing
test('textOfContent joins only text blocks', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'image' },
    { type: 'text', text: 'b' }]), 'a\n\nb')
  assert.equal(textOfContent(null), '')
})

test('replaceTextContent replaces the first text block and keeps other blocks', () => {
  const out = replaceTextContent([{ type: 'text', text: 'old' }, { type: 'image', data: 1 },
    { type: 'text', text: 'gone' }], 'NEW')
  assert.deepEqual(out, [{ type: 'text', text: 'NEW' }, { type: 'image', data: 1 }])
})

test('replaceTextContent inserts a text block when there is none to replace', () => {
  const out = replaceTextContent([{ type: 'image', data: 1 }], 'NEW')
  assert.deepEqual(out[0], { type: 'text', text: 'NEW' })
  assert.equal(out.length, 2)
})

test('the post-execute listener delegates when the hook is disabled', async () => {
  const config = resolveConfig({ hook: { enabled: false } })
  const listener = createPostExecuteScreen(config)
  let delegated = false
  const decision = await listener({ name: 'read_file' },
    { isError: false, content: [{ type: 'text', text: 'x'.repeat(20000) }] },
    async () => { delegated = true; return { kind: 'accept' } })
  assert.equal(delegated, true)
  assert.deepEqual(decision, { kind: 'accept' })
})

test('the post-execute listener ignores small results and error results', async () => {
  const config = resolveConfig({ hook: { enabled: true, minChars: 8000 } })
  const listener = createPostExecuteScreen(config)
  for (const result of [
    { isError: false, content: [{ type: 'text', text: 'short' }] },
    { isError: true, content: [{ type: 'text', text: 'x'.repeat(20000) }] },
    { isError: false, content: [] },
  ]) {
    let delegated = false
    await listener({ name: 'read_file' }, result, async () => {
      delegated = true
      return { kind: 'accept' }
    })
    assert.equal(delegated, true, JSON.stringify(result).slice(0, 60))
  }
})

test('the post-execute listener ignores tools the hook does not cover', async () => {
  const config = resolveConfig({ hook: { enabled: true, tools: ['read_*'], minChars: 10 } })
  const listener = createPostExecuteScreen(config)
  let delegated = false
  await listener({ name: 'write_file' },
    { isError: false, content: [{ type: 'text', text: 'x'.repeat(1000) }] },
    async () => { delegated = true; return { kind: 'accept' } })
  assert.equal(delegated, true)
})

test('the post-execute listener survives being called without next()', async () => {
  const config = resolveConfig({ hook: { enabled: true, minChars: 10 } })
  const warnings = []
  const listener = createPostExecuteScreen(config, { warn: (m) => warnings.push(m) })
  const decision = await listener({ name: 'read_file' },
    { isError: false, content: [{ type: 'text', text: 'x'.repeat(1000) }] }, undefined)
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(warnings.length, 1)
})

test('an unreachable service passes the result through with an explicit unscreened note', async () => {
  const config = resolveConfig({ hook: { enabled: true, minChars: 10 } })
  const listener = createPostExecuteScreen(config, undefined, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  const body = 'x'.repeat(1000)
  const decision = await listener({ name: 'read_file' },
    { isError: false, content: [{ type: 'text', text: body }] }, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  const text = decision.content[0].text
  assert.match(text, /not screened/)
  assert.ok(text.includes(body), 'the original text must still be there in full')
})

test('a serving mock screens the large result and reports the removal', async () => {
  // The fake service scores by a marker that is NOT the dropped text itself, so
  // the assertions below can tell the surviving body apart from the digest.
  const NOISE_MARK = '__DROP_ME__'
  const NOISE_TEXT = 'irrelevant filler '.repeat(40)
  const SIGNAL_TEXT = 'signal '.repeat(60)
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const items = body.requests.map((r) => ({
      answers: { keep: r.state.includes(NOISE_MARK) || r.state.includes(NOISE_TEXT.slice(0, 30))
        ? 2
        : 9 },
      answer_confidence: { keep: 0.8 },
    }))
    return { ok: true, status: 200, json: async () => items, text: async () => '' }
  }
  const config = resolveConfig({ hook: { enabled: true, minChars: 10 }, minBlockChars: 10 })
  const listener = createPostExecuteScreen(config, undefined, { fetchImpl })
  const droppedBlock = `${NOISE_TEXT}${NOISE_MARK}`
  const text = [droppedBlock, SIGNAL_TEXT].join('\n\n')
  const decision = await listener({ name: 'read_file' },
    { isError: false, content: [{ type: 'text', text }] }, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  const out = decision.content[0].text

  // The model-facing body carries the surviving block and not the dropped one.
  const body = out.split('[phocinae-screen dropped')[0]
  assert.ok(body.includes(SIGNAL_TEXT.trim().slice(0, 40)), 'the relevant block survives')
  assert.ok(!body.includes(NOISE_MARK),
    'the dropped block leaves the model-facing body entirely')

  // The dropped block is still recognisable in the digest, and recoverable
  // byte-for-byte from the ORIGINAL text by the offsets/length it reports.
  assert.match(out, /dropped 1 block/)
  const digestLine = out.split('\n').find((l) => l.startsWith('- b000'))
  assert.ok(digestLine, 'the digest names the dropped block id')
  const chars = Number(/chars (\d+)/.exec(digestLine)[1])
  assert.equal(chars, droppedBlock.length, 'the digest reports the true block length')
  assert.equal(text.slice(0, chars), droppedBlock,
    'the first `chars` bytes of the original are exactly the dropped block')
  assert.ok(out.includes(NOISE_TEXT.trim().slice(0, 30)),
    'the digest shows enough of the block to recognise it')
})
