/**
 * measure-screen.mjs — calibrate the keep/drop boundary on a labelled set.
 *
 * Context: the 2-10 `score` question returned 2-3 for everything (no signal) and
 * `noul` showed pure positional bias. A balanced 2-option `choice` did separate a
 * relevant block from filler, so the screen is rebuilt on that. This script
 * measures what boundary to use, rather than guessing one.
 *
 * Method: 24 blocks, 12 that a task genuinely needs and 12 that it does not, all
 * from the same fictional debugging task so the only variable is relevance. Each
 * block is asked the same question; we record P(needed) and whether the answer
 * was "needed". Then we sweep the P(needed) boundary and report the confusion
 * matrix for each candidate — including a do-nothing baseline, because a screen
 * that keeps everything is only worth shipping if it beats that.
 *
 * Run: node docs/measure-screen.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'
const TASK = 'Find the cause of the failing refund test and the fix.'

const KEEP = [
  'Answer: the bug is in RefundCalculator.sum(). It filters on status in ("paid", '
  + '"cancelled"), so the filter should be status == "paid".',
  'Task: test_refund asserts refund totals exclude cancelled orders. Result: '
  + 'RefundCalculator.sum() counts cancelled orders.',
  'Traceback (most recent call last): File "refund.py", line 42, in sum -> '
  + 'TypeError: unsupported operand. This is the failure under investigation.',
  'The test expects 120.00 but receives 180.00; the difference is 60.00, which is '
  + 'exactly the cancelled order, so cancellation is the cause.',
  'Fix applied: change the status filter to exclude cancelled orders. Verified: '
  + 'test_cancelled_excluded now passes.',
  'Reproduction: run pytest tests/test_refund.py::test_cancelled_excluded.',
  'Note from the author: the refund total must exclude cancelled orders; this is a '
  + 'business rule, not a bug in the test.',
  'Diff: -status in ("paid", "cancelled")  +status == "paid"  # this is the fix',
  'The relevant module is RefundCalculator in payments/refund.py; the failing call '
  + 'site is on line 42.',
  'Regression history: this assertion was added after a customer was over-refunded, '
  + 'so it must keep failing until the filter is corrected.',
  'Expected vs actual: expected 120.00, actual 180.00 — a 50% overcount caused by '
  + 'including the cancelled order.',
  'Conclusion: cancelled orders are being summed; the status predicate is wrong.',
]

const DROP = [
  'GET /static/app.css 200 1.2ms\nGET /static/app.js 200 3.4ms\nGET /favicon.ico '
  + '404 0.3ms\nGET /static/logo.svg 200 0.9ms',
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  + 'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam.',
  'Copyright 2026 Example Corp. All rights reserved. Licensed under Apache-2.0. '
  + 'See LICENSE for the full text of the licence and its terms.',
  'Table of contents: 1 Introduction 2 Installation 3 Configuration 4 Usage '
  + '5 Troubleshooting 6 Frequently asked questions 7 Licence',
  'Are you sure you want to continue? [y/N] ',
  '..... 10% ..... 20% ..... 30% ..... 40% ..... 50% ..... 60% ..... 70%',
  'The documentation for this project is generated with Sphinx and hosted on '
  + 'readthedocs. Contributions are welcome via pull request.',
  '1234567890 1234567890 1234567890 1234567890 1234567890 1234567890 1234567890',
  'All the leaves are brown and the sky is grey; I have been for a walk on a '
  + 'winter day. This line has nothing to do with refunds.',
  'package-lock.json resolved fields: {"integrity":"sha512-AAAA","resolved":'
  + '"https://registry.npmjs.org/x/-/x-1.0.0.tgz"}',
  'Please note that the terms and conditions set out in schedule 2 shall apply '
  + 'mutatis mutandis to any variation of this agreement.',
  'ADVERTISEMENT: buy our course and become a ten-times engineer in thirty days, '
  + 'no experience required, click the link in the description below.',
]

const OPTIONS = [
  `This block is needed to work on the task: ${TASK}`,
  'This block is not needed and can be removed before the task is worked on',
]

try {
  const res = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (err) {
  console.error(`phocinae-server unreachable: ${err.message}`)
  process.exit(2)
}

async function pNeeded(text) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state: text,
      questions: [{ id: 'v', type: 'choice', options: OPTIONS, instructions: 'Choose.' }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  const p = d.option_scores?.v
  const idx = d.answers?.v
  // option_scores is keyed by question id; entry order matches the option order.
  return { pNeeded: Array.isArray(p) ? p[0] : (idx === 0 ? 1 : 0), index: idx,
    confidence: d.answer_confidence?.v }
}

console.log(`endpoint : ${ENDPOINT}`)
console.log(`task     : ${TASK}`)
console.log(`blocks   : ${KEEP.length} need-keeping, ${DROP.length} droppable\n`)

const samples = []
for (const [label, list] of [['keep', KEEP], ['drop', DROP]]) {
  for (const text of list) {
    const r = await pNeeded(text)
    samples.push({ label, ...r, head: text.slice(0, 48).replace(/\s+/g, ' ') })
  }
}

console.log('label  P(needed)  answer    head')
for (const s of samples) {
  console.log(`${s.label.padEnd(6)} ${s.pNeeded.toFixed(3).padStart(9)}  `
    + `${(s.index === 0 ? 'needed' : 'droppable').padEnd(9)} ${s.head}`)
}

const keepPs = samples.filter((s) => s.label === 'keep').map((s) => s.pNeeded)
const dropPs = samples.filter((s) => s.label === 'drop').map((s) => s.pNeeded)
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
console.log(`\nmean P(needed): keep ${mean(keepPs).toFixed(3)}  drop ${mean(dropPs).toFixed(3)}`)
console.log(`min  P(needed): keep ${Math.min(...keepPs).toFixed(3)}  drop ${Math.max(...dropPs).toFixed(3)} (drop max)`)

console.log('\nboundary sweep — a block is DROPPED when P(needed) <= boundary:')
console.log('boundary  dropped-keep (BAD)  kept-drop (costs tokens)  correct/total')
const candidates = [0.30, 0.35, 0.40, 0.44, 0.46, 0.48, 0.50, 0.52, 0.55, 0.60]
let best = null
for (const b of candidates) {
  const droppedKeep = samples.filter((s) => s.label === 'keep' && s.pNeeded <= b).length
  const keptDrop = samples.filter((s) => s.label === 'drop' && s.pNeeded > b).length
  const correct = samples.length - droppedKeep - keptDrop
  console.log(`${b.toFixed(2).padStart(8)}  ${String(droppedKeep).padStart(17)}  `
    + `${String(keptDrop).padStart(22)}  ${correct}/${samples.length}`)
  // Prefer zero false drops; break ties by the most tokens saved.
  if (droppedKeep === 0 && (!best || keptDrop < best.keptDrop)) {
    best = { b, droppedKeep, keptDrop, correct }
  }
}

console.log('\ndo-nothing baseline: drop nothing -> 0 false drops, 12 blocks of filler kept')
if (best) {
  console.log(`recommended boundary: P(needed) <= ${best.b} -> `
    + `${best.droppedKeep} false drops, ${best.keptDrop} filler blocks kept, `
    + `${best.correct}/${samples.length} correct`)
} else {
  console.log('NO boundary achieves zero false drops on this set — the screen cannot be')
  console.log('shipped with a drop rule; it must keep everything or ask a larger model.')
}
