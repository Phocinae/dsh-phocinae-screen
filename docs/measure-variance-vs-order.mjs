/**
 * measure-variance-vs-order.mjs — 把「顺序敏感」与「本身就不稳定」分开。
 *
 * 上一版 measure-flip-invariance.mjs 得到一个粗结论：轮换选项位置会让 4/12 的
 * 判定改变。但那 4 例里混着两种完全不同的原因，不加区分会得出误导性的结论：
 *
 *   A) **顺序敏感**：同一句话、同一组选项，只换位置，答案就变。
 *   B) **本身随机**：连位置都不换，重复问几遍答案就不一样。
 *
 * 只有 A 是"位置在决定答案"；B 说明这个判定的方差本来就大，与顺序无关。
 * 两者都让自动判定不可靠，但**修法不同**：A 可以靠固定选项顺序缓解，
 * B 完全没法缓解。
 *
 * 方法：对每条判定做两组测量
 *   1. 固定顺序重复 N 次        → 得到"基线方差"
 *   2. 把正确选项轮换到各位置    → 得到"顺序效应"
 * 再比较：把选项排成任意一个固定顺序，答案会不会自己变？
 *
 * Run: node docs/measure-variance-vs-order.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'
const REPEATS = 5

const CASES = [
  { state: 'The build failed on Windows but passed on Linux.',
    options: ['investigate the Windows path handling', 'ignore it and ship',
              'escalate to the platform team'],
    correct: 'investigate the Windows path handling' },
  { state: 'A customer reports they were charged twice for one order.',
    options: ['refund the duplicate charge', 'ask them to wait 30 days',
              'close the ticket without action'],
    correct: 'refund the duplicate charge' },
  { state: 'The TLS certificate for the API expires in 3 days.',
    options: ['renew the certificate now', 'wait until it expires', 'disable TLS'],
    correct: 'renew the certificate now' },
  { state: 'Disk usage on the primary database host is at 96%.',
    options: ['add capacity or archive data', 'do nothing', 'restart the host'],
    correct: 'add capacity or archive data' },
  { state: 'The nightly backup job has failed for four consecutive nights.',
    options: ['investigate the backup failure', 'ignore it for now',
              'delete the backup job'],
    correct: 'investigate the backup failure' },
  { state: 'Latency on the checkout endpoint rose from 180ms to 1.4s.',
    options: ['profile the endpoint for a regression', 'leave it as is',
              'increase the timeout'],
    correct: 'profile the endpoint for a regression' },
  { state: 'A dependency has a published security advisory.',
    options: ['upgrade to a fixed version', 'pin the vulnerable version',
              'remove the dependency without a replacement'],
    correct: 'upgrade to a fixed version' },
  { state: 'The staging environment drifted from the infrastructure definition.',
    options: ['reapply the definition', 'change production to match staging',
              'delete the staging environment'],
    correct: 'reapply the definition' },
  { state: 'An alert fired once and did not repeat.',
    options: ['check whether it mattered and record the finding',
              'silence the alert permanently', 'page the on-call engineer'],
    correct: 'check whether it mattered and record the finding' },
  { state: 'Two services both claim to own the same database table.',
    options: ['decide on one owner and document it', 'let both keep writing',
              'drop the table'],
    correct: 'decide on one owner and document it' },
  { state: 'The test suite takes 22 minutes and runs on every push.',
    options: ['split the suite so fast tests run first',
              'stop running tests on push', 'delete the slow tests'],
    correct: 'split the suite so fast tests run first' },
  { state: 'A user asks for a feature that duplicates an existing one.',
    options: ['point them at the existing feature', 'build the duplicate anyway',
              'close the request without replying'],
    correct: 'point them at the existing feature' },
]

async function ask(state, options) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state,
      questions: [{ id: 'v', type: 'choice', options,
                    instructions: 'Choose the one option that should be taken.' }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  return options[d.answers?.v]
}

function permute(options, correct, slot) {
  const others = options.filter((o) => o !== correct)
  const out = []
  let k = 0
  for (let i = 0; i < options.length; i += 1) {
    if (i === slot) out.push(correct)
    else { out.push(others[k]); k += 1 }
  }
  return out
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
console.log(`cases: ${CASES.length} · fixed-order repeats: ${REPEATS} · order permutations: 3\n`)

let unstableFixed = 0   // 固定顺序重复也会变 -> 本身随机
let orderSensitive = 0  // 固定顺序稳定，但换顺序会变 -> 顺序敏感
let fullyStable = 0
let correctFixed = 0
let totalFixed = 0

const detail = []
for (const c of CASES) {
  // 1) 固定顺序重复
  const fixed = []
  for (let i = 0; i < REPEATS; i += 1) fixed.push(await ask(c.state, c.options))
  const fixedDistinct = new Set(fixed)
  const fixedUnstable = fixedDistinct.size > 1
  totalFixed += REPEATS
  correctFixed += fixed.filter((p) => p === c.correct).length

  // 2) 每个位置各问一次
  const perSlot = []
  for (let slot = 0; slot < c.options.length; slot += 1) {
    const opts = permute(c.options, c.correct, slot)
    perSlot.push(await ask(c.state, opts))
  }
  const slotDistinct = new Set(perSlot)

  let kind
  if (fixedUnstable) { kind = 'random'; unstableFixed += 1 }
  else if (slotDistinct.size > 1) { kind = 'order-sensitive'; orderSensitive += 1 }
  else { kind = 'stable'; fullyStable += 1 }

  detail.push({ c, fixed, perSlot, kind })
  console.log(`  [${kind.padEnd(15)}] ${c.state.slice(0, 50)}`)
  console.log(`      fixed order x${REPEATS} : ${fixed.map((p) => (p === c.correct ? 'R' : 'x')).join(' ')}`
    + `   (R = correct)  distinct=${fixedDistinct.size}`)
  console.log(`      by position       : ${perSlot.map((p) => (p === c.correct ? 'R' : 'x')).join(' ')}`
    + `   distinct=${slotDistinct.size}`)
}

console.log('\n=== breakdown ===')
console.log(`  fixed order x${REPEATS} already varies (inherent variance) : ${unstableFixed}/${CASES.length}`)
console.log(`  stable at a fixed order but changes when shuffled      : ${orderSensitive}/${CASES.length}`)
console.log(`  stable under both                                      : ${fullyStable}/${CASES.length}`)
console.log(`\n  accuracy over ${totalFixed} fixed-order runs            : `
  + `${correctFixed}/${totalFixed} (${(correctFixed / totalFixed * 100).toFixed(0)}%)`)

console.log('\n=== what this means for automation ===')
if (unstableFixed) {
  console.log(`  ${unstableFixed} case(s) vary even with the options in a fixed order. No interface`)
  console.log('  choice fixes that; the decision simply is not reproducible.')
}
if (orderSensitive) {
  console.log(`  ${orderSensitive} case(s) are stable only while the order is fixed. Shuffling options —`)
  console.log('  which is what a caller does to avoid positional bias — changes the answer.')
}
if (!unstableFixed && !orderSensitive) {
  console.log('  Answers are reproducible and order-independent on this sample.')
}
console.log('\n  Combining both effects: a caller cannot both (a) randomise option order to')
console.log('  avoid bias and (b) rely on the answer. One of the two has to go.')
