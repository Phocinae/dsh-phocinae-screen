/**
 * measure-flip-invariance.mjs — 测 S22「选项洗牌稳健」（gallery 标注：翻转率 0.0217）。
 *
 * 为什么这一族值得单独测，而且**不需要标注集**：S22 声称的不是"判得对"，而是
 * "判得稳" —— 把选项顺序打乱后，判定高度一致。这是一个**内部一致性**主张，
 * 只要同一批输入重复问、每次换顺序，就能测，不需要人来标对错。
 *
 * 这一点很关键：前面五次测量的失败都可以辩解为"我的标注集有偏/题面不合适"，
 * 而翻转率不是 —— 同一句话、同一组选项、只有顺序变，答案却变，那与标注无关，
 * 是模型自身的不稳定。所以这个测量比前面几个更难反驳，也更能界定"能不能用它
 * 做自动判定"。
 *
 * 方法：取 12 条判定（每条的正确答案是构造时就确定的），对每条把正确选项轮换到
 * 每个位置各问一次，统计"答案所指的那个选项"是否始终是同一个**语义选项**
 * （而不是同一个位置）。
 *
 * Run: node docs/measure-flip-invariance.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

// 每条：state + 选项集合 + 构造时确定的正确答案（按选项文本标识，与位置无关）
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
    options: ['renew the certificate now', 'wait until it expires',
              'disable TLS'],
    correct: 'renew the certificate now' },
  { state: 'Disk usage on the primary database host is at 96%.',
    options: ['add capacity or archive data', 'do nothing', 'restart the host'],
    correct: 'add capacity or archive data' },
  { state: 'A pull request changes 40 files and nobody has reviewed it.',
    options: ['request a review before merging', 'merge it directly',
              'close the pull request'],
    correct: 'request a review before merging' },
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
    options: ['decide on one owner and document it',
              'let both keep writing', 'drop the table'],
    correct: 'decide on one owner and document it' },
  { state: 'The test suite takes 22 minutes and runs on every push.',
    options: ['split the suite so fast tests run first',
              'stop running tests on push', 'delete the slow tests'],
    correct: 'split the suite so fast tests run first' },
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
  return { idx: d.answers?.v, p: d.option_scores?.v ?? [],
           conf: d.answer_confidence?.v }
}

/** 把 correct 放到 slot 位置的排列。 */
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
console.log(`cases   : ${CASES.length} (3 options each, so 3 permutations)\n`)

let totalRuns = 0
let flips = 0          // 语义答案发生变化
let correctRuns = 0
const perCase = []

for (const c of CASES) {
  const picks = []
  for (let slot = 0; slot < c.options.length; slot += 1) {
    const opts = permute(c.options, c.correct, slot)
    const a = await ask(c.state, opts)
    const picked = opts[a.idx]
    picks.push({ slot, picked })
    totalRuns += 1
    if (picked === c.correct) correctRuns += 1
  }
  const distinct = new Set(picks.map((p) => p.picked))
  const flipped = distinct.size > 1
  if (flipped) flips += 1
  perCase.push({ ...c, picks, flipped })
  console.log(`  ${flipped ? 'FLIP' : 'ok  '} ${c.state.slice(0, 52)}`)
  for (const p of picks) {
    const isRight = p.picked === c.correct
    console.log(`        slot ${p.slot}: ${isRight ? 'correct  ' : 'WRONG    '} ${String(p.picked).slice(0, 46)}`)
  }
}

console.log('\n=== result ===')
console.log(`  runs                      : ${totalRuns}`)
console.log(`  cases whose answer changed: ${flips}/${CASES.length}`
  + `  (flip rate ${(flips / CASES.length).toFixed(4)})`)
console.log(`  answers that were correct : ${correctRuns}/${totalRuns}`
  + `  (${(correctRuns / totalRuns * 100).toFixed(0)}%)`)
console.log(`  gallery claims flip rate  : 0.0217`)

console.log('\n=== per-slot accuracy (does position decide?) ===')
const slotHits = [0, 0, 0]
const slotTotals = [0, 0, 0]
for (const c of perCase) {
  for (const p of c.picks) {
    slotTotals[p.slot] += 1
    if (p.picked === c.correct) slotHits[p.slot] += 1
  }
}
for (let s = 0; s < 3; s += 1) {
  console.log(`  correct option at slot ${s}: ${slotHits[s]}/${slotTotals[s]}`
    + `  (${(slotHits[s] / slotTotals[s] * 100).toFixed(0)}%)`)
}

console.log('\n=== verdict ===')
const rate = flips / CASES.length
if (rate <= 0.05) {
  console.log('  Stable: the answer follows the option, not its position. The gallery')
  console.log('  claim holds on this sample.')
} else if (rate <= 0.25) {
  console.log('  Unstable enough to matter: the same question with shuffled options')
  console.log(`  changes the answer in ${(rate * 100).toFixed(0)}% of cases. Any automated use would`)
  console.log('  need the position fixed and held constant, not randomised.')
} else {
  console.log('  Position, not content, is deciding the answer.')
}
