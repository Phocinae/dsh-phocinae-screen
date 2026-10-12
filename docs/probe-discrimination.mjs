/**
 * probe-discrimination.mjs — can the local model actually separate relevant from
 * irrelevant context, and does the question's phrasing change that?
 *
 * Why this exists: the first live run scored a clearly task-relevant block 3 —
 * the same as pure lorem-ipsum filler. Only the drop guard stopped the screen
 * from removing everything. Before shipping a screen whose whole purpose is that
 * separation, I need to know whether the model can do it at all, and with which
 * rubric. This script answers that with real requests; it asserts nothing.
 *
 * Run: node tools/probe-discrimination.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

const TASK = 'The failing test test_refund asserts refund totals exclude cancelled orders.'
const BLOCKS = {
  'task-relevant': 'Task: the failing test asserts that refund totals exclude cancelled '
    + 'orders. Result: RefundCalculator.sum() adds every order with status paid OR '
    + 'cancelled, so a cancelled order is counted twice. The fix belongs in the status '
    + 'filter. Reproduction: pytest tests/test_refund.py::test_cancelled_excluded fails '
    + 'with expected 120.00 but got 180.00, exactly the cancelled order of 60.00.',
  'generic-filler': 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '
    + 'tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis '
    + 'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis '
    + 'aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat.',
  'unrelated-log': 'GET /static/app.css 200 1.2ms\nGET /static/app.js 200 3.4ms\n'
    + 'GET /favicon.ico 404 0.3ms\nGET /static/logo.svg 200 0.9ms\n'
    + 'GET /static/app.css 304 0.4ms\nGET /static/app.js 304 0.3ms\n'
    + 'GET /health 200 0.6ms\nGET /static/font.woff2 200 2.1ms\n',
  'near-duplicate': 'Task: the failing test asserts that refund totals exclude cancelled '
    + 'orders. Result: RefundCalculator.sum() adds every order with status paid OR '
    + 'cancelled, so a cancelled order is counted twice. The fix belongs in the status '
    + 'filter. Reproduction: pytest tests/test_refund.py::test_cancelled_excluded fails '
    + 'with expected 120.00 but got 180.00, exactly the cancelled order of 60.00. '
    + '(This is the second copy of the block above.)',
  'answers-directly': 'Answer: the bug is in RefundCalculator.sum(). It filters on '
    + 'status in ("paid", "cancelled") but the test expects cancelled orders to be '
    + 'excluded, so the filter should be status == "paid".',
}

const RUBRICS = {
  'A. generic relevance (shipped first draft)':
    'Rate how much unique, task-relevant information this block carries. '
    + '2 = boilerplate, a duplicate, or an error trace with no bearing on the task; '
    + '10 = the block answers a question the task explicitly asks.',
  'B. explicit anchoring': `The task is: "${TASK}" Rate how much this block helps answer `
    + 'that specific task. 2 = nothing in it bears on the task; 10 = it directly states '
    + 'the cause or the fix the task asks for.',
  'C. keep-or-drop binary framed as a score':
    `The task is: "${TASK}" Score 2 if this block should be REMOVED before the task is `
    + 'worked on, and 9 if it should be KEPT. Use 2 only for text that repeats something '
    + 'already said, or has no connection to the task at all.',
  'D. consequence framing':
    `Someone is fixing this task: "${TASK}" If this block were deleted, how much would `
    + 'that hurt? 2 = deleting it loses nothing; 10 = deleting it loses the answer.',
}

async function scoreWith(rubric, text) {
  const body = {
    model: 'Phocinae-Largha-150M-v1',
    state: text,
    questions: [{ id: 'keep', type: 'score', instructions: rubric }],
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return {
    score: data.answers?.keep,
    confidence: data.answer_confidence?.keep,
    option_scores: data.option_scores?.keep,
  }
}

// Reachability
try {
  const res = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (err) {
  console.error(`phocinae-server unreachable at ${ENDPOINT}: ${err.message}`)
  process.exit(2)
}

const names = Object.keys(BLOCKS)
console.log(`endpoint: ${ENDPOINT}`)
console.log(`blocks  : ${names.join(', ')}\n`)

console.log('score (2-10) per rubric; the two rows that SHOULD separate are marked *\n')
const header = ['rubric'.padEnd(44), ...names.map((n) => n.slice(0, 15).padStart(17))].join('')
console.log(header)
console.log('-'.repeat(header.length))

const results = {}
for (const [label, rubric] of Object.entries(RUBRICS)) {
  const row = []
  results[label] = {}
  for (const n of names) {
    const r = await scoreWith(rubric, BLOCKS[n])
    results[label][n] = r
    row.push(`${String(r.score).padStart(10)} (${(r.confidence ?? 0).toFixed(2)})`)
  }
  console.log(label.padEnd(44) + row.map((c) => c.padStart(17)).join(''))
}

console.log('\nseparation between answers-directly (should be highest) and generic-filler')
console.log('(should be lowest):')
for (const label of Object.keys(RUBRICS)) {
  const hi = results[label]['answers-directly']?.score
  const lo = results[label]['generic-filler']?.score
  const dup = results[label]['near-duplicate']?.score
  console.log(`  ${label.padEnd(44)} hi=${hi} lo=${lo} delta=${hi - lo} near-dup=${dup}`)
}

console.log('\ndistinct score values seen per rubric (a screen needs spread, not one value):')
for (const label of Object.keys(RUBRICS)) {
  const vals = new Set(names.map((n) => results[label][n]?.score))
  console.log(`  ${label.padEnd(44)} ${[...vals].sort().join(', ')}  (${vals.size} distinct)`)
}
