/**
 * live.test.mjs — real-machine test against a running phocinae-server.
 *
 * The offline suite proves the logic; this proves the protocol. It sends real
 * blocks to the real 144.3M model and checks that the scores, the batching and
 * the throughput claims hold on this machine.
 *
 * Run: PHOC_SERVER=http://127.0.0.1:8155/v1/systemone node test/live.test.mjs
 * Exit 2 when the service is unreachable — "not run", never a silent pass.
 */
import { resolveConfig, runScreen, splitBlocks } from '../index.mjs'

const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'
const config = resolveConfig({ endpoint: ENDPOINT, timeoutMs: 120000, audit: false })

let pass = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

// Reachability first: an unreachable service must read as "not run".
try {
  const res = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (err) {
  console.error(`SKIP  phocinae-server unreachable at ${ENDPOINT}`)
  console.error(`      ${err && err.message ? err.message : String(err)}`)
  process.exit(2)
}

console.log(`live target: ${ENDPOINT}\n`)

// ---------------------------------------------------------------- 1. plumbing
const probe = await runScreen('probe block one\n\nprobe block two', config)
check('a small two-block input returns a non-degraded verdict',
  !probe.degraded, probe.reason)
check('every block was scored by the real service',
  probe.scored === probe.blockCount, `scored ${probe.scored}/${probe.blockCount}`)
check('blockCount reflects the split', probe.blockCount === 2, String(probe.blockCount))

// ------------------------------------------------- 2. relevance separation
// A task-relevant block and a block of obvious filler, same length, so the
// scores differ because of content and not because of size.
const taskBlock = [
  'Task: the failing test asserts that refund totals exclude cancelled orders.',
  'Result: RefundCalculator.sum() adds every order with status paid OR cancelled,',
  'so a cancelled order is counted twice. The fix belongs in the status filter.',
  'Reproduction: run pytest tests/test_refund.py::test_cancelled_excluded — it fails',
  'with expected 120.00 but got 180.00, i.e. exactly the cancelled order of 60.00.',
].join(' ')
const fillerBlock = [
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor',
  'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud',
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute',
  'irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat',
  'nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa.',
].join(' ')
const mixed = `${taskBlock}\n\n${fillerBlock}`
const screened = await runScreen(mixed, config)

check('the mixed input produced a verdict', ['screened', 'passthrough', 'refused']
  .includes(screened.decision), screened.decision)
check('the task-relevant block was scored', screened.scored >= 2, String(screened.scored))

const taskScore = screened.keep.concat(screened.dropped)
  .find((b) => b.text.startsWith('Task:'))?.score
const fillerScore = screened.keep.concat(screened.dropped)
  .find((b) => b.text.startsWith('lorem'))?.score
console.log(`      task block score=${taskScore}  filler block score=${fillerScore}`)
check('the relevance scores are integers on the 2-10 scale',
  Number.isInteger(taskScore) && taskScore >= 2 && taskScore <= 10 &&
  Number.isInteger(fillerScore) && fillerScore >= 2 && fillerScore <= 10,
  `task=${taskScore} filler=${fillerScore}`)

// The separation claim is reported rather than asserted as a pass/fail: an
// uncalibrated 150M model is allowed to score filler as high as the task, and
// pretending otherwise would be the dishonest test.
check('the screen did not drop the task-relevant block',
  !screened.dropped.some((b) => b.text.startsWith('Task:')),
  `dropped=${screened.dropped.map((b) => b.id).join(',')}`)

// ------------------------------------------------- 3. drop guard under load
const manyFiller = Array.from({ length: 30 }, (_, i) =>
  `Filler block ${i}: ` + 'irrelevant boilerplate text. '.repeat(20)).join('\n\n')
const bulk = await runScreen(manyFiller, config)
check('a 30-block input is accepted and scored in one or more batches',
  bulk.blockCount === 30 && bulk.scored === 30,
  `blocks=${bulk.blockCount} scored=${bulk.scored}`)
check('the drop guard held: a screen that would remove everything is refused or partial',
  bulk.decision !== 'screened' || bulk.dropped.length < bulk.blockCount,
  `decision=${bulk.decision} dropped=${bulk.dropped.length}`)

// ------------------------------------------------- 4. throughput (S09 claim)
const t0 = Date.now()
const timed = await runScreen(
  Array.from({ length: 30 }, (_, i) => `Block ${i}: ` + 'content '.repeat(40)).join('\n\n'),
  config)
const wall = Date.now() - t0
const perBlock = wall / 30
console.log(`      30 blocks in ${wall} ms = ${perBlock.toFixed(1)} ms/block`)
check('a 30-block screen finishes in a sane wall time on this machine',
  wall < 30000, `${wall} ms`)
check('the per-block cost is reported, not asserted against a stale figure',
  perBlock > 0 && Number.isFinite(perBlock), String(perBlock))
void timed

// ------------------------------------------------- 5. recoverability, for real
if (screened.dropped.length > 0) {
  const dropped = screened.dropped[0]
  check('a dropped block is recoverable byte-for-byte from the original by its offsets',
    mixed.slice(dropped.start, dropped.end) === dropped.text,
    `offsets ${dropped.start}..${dropped.end}`)
  check('the rendered text carries a digest entry for the dropped block',
    screened.text.includes(dropped.id), dropped.id)
} else {
  console.log('SKIP  recoverability check (nothing was dropped in this run)')
}

console.log(`\nRESULT  ${pass} passed, ${failures.length} failed, ${pass + failures.length} total`)
console.log(`BASE    ${ENDPOINT}`)
if (failures.length) {
  console.log('FAILED:')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exit(failures.length ? 1 : 0)
