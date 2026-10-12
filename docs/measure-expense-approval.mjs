/**
 * measure-expense-approval.mjs — 测 S15「报销预判」（gallery 标注：无发票报销 p(approve)=0.07）。
 *
 * 为什么这一族值得单独测，而且可能与前七族不同：它是**规则形状 + 真灰区**。
 *   * 规则形状：发票在不在、金额有没有超政策上限 —— 逐条可查
 *   * 真灰区：描述含糊但没有明确违规的（"与客户吃饭，金额合理"）—— 规则判不了
 *
 * 前面 S18（发票算术）证明"规则能做到的事模型做不到"；但那个场景**没有灰区** ——
 * 12 张全部可由算术判定。这里是第一个既有规则内核、又**确实存在规则读不懂的条目**
 * 的场景。所以它检验的命题与前七族都不同：
 *
 *     "规则先定夺、灰区交给模型" 这个分工，到底成不成立？
 *
 * 测三种形态（与 S18 同一框架，便于横向比较）：
 *   A) 纯规则            —— 只查发票有无与政策上限，灰区一律标"需人工"
 *   B) 纯模型            —— 每条都问模型"该不该批"
 *   C) 规则 + 模型灰区    —— 规则能定的定，剩下才问模型
 *
 * 判据：危险侧错误 = 把**应该拒**的判成批（放行违规报销）。这一侧的代价远大于
 * 把该批的判成需人工（多一次核对）。
 *
 * Run: node docs/measure-expense-approval.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

// 政策（写在题面里，规则层据此判定）
const POLICY = {
  receiptRequiredOver: 500,      // 超过 500 必须有发票
  caps: { meal: 300, taxi: 200, hotel: 1200, supplies: 800 },
  priorApprovalOver: 2000,       // 超过 2000 需事前审批
}

/** 每条：类别、金额（元）、有无发票、是否事前审批、文字描述、真实标签 */
const CLAIMS = [
  // --- 明确违规：应拒 ---
  { cat: 'meal', amount: 880, receipt: false, preApproved: false, label: 'reject',
    text: '与客户晚餐，880 元，无发票，客户口头同意报价' },
  { cat: 'hotel', amount: 3600, receipt: true, preApproved: false, label: 'reject',
    text: '出差住宿三晚共 3600 元，有发票，未事前申请' },
  { cat: 'supplies', amount: 1450, receipt: true, preApproved: false, label: 'reject',
    text: '采购办公用品 1450 元（超过类别上限 800），有发票' },
  { cat: 'taxi', amount: 640, receipt: false, preApproved: false, label: 'reject',
    text: '打车 640 元（超过类别上限 200），无发票' },
  { cat: 'meal', amount: 2400, receipt: true, preApproved: false, label: 'reject',
    text: '团队聚餐 2400 元，有发票，未事前申请（超 2000 需事前审批）' },

  // --- 明确合规：应批 ---
  { cat: 'meal', amount: 260, receipt: false, preApproved: false, label: 'approve',
    text: '工作午餐 260 元，未超 500 故无需发票，也未超类别上限 300' },
  { cat: 'taxi', amount: 88, receipt: false, preApproved: false, label: 'approve',
    text: '机场打车 88 元，未超 500 无需发票，未超上限 200' },
  { cat: 'supplies', amount: 320, receipt: false, preApproved: false, label: 'approve',
    text: '购买键鼠 320 元，未超 500 无需发票，未超上限 800' },
  { cat: 'hotel', amount: 1100, receipt: true, preApproved: false, label: 'approve',
    text: '出差住宿 1100 元，有发票，未超类别上限 1200，未超 2000' },
  { cat: 'meal', amount: 300, receipt: false, preApproved: false, label: 'approve',
    text: '工作餐 300 元，恰好等于类别上限 300' },

  // --- 真灰区：描述含糊，但字段仍可判定 ---
  // 注意：我最初把下面第一条标成 approve，把它想成"灰区"。**那是我标错了** ——
  // meal 上限 300，520 明明超限，规则拒它是对的。灰区必须是真的没有明确违规才好用，
  // 否则会把"规则判对了"记成"规则误拒"。
  { cat: 'meal', amount: 520, receipt: true, preApproved: false, label: 'reject',
    text: '与合作伙伴商务餐叙，520 元（超过类别上限 300），有发票，描述里声称"金额合理"' },
  { cat: 'taxi', amount: 180, receipt: false, preApproved: false, label: 'approve',
    text: '夜间加班打车 180 元，未超上限，未超 500' },
  // 真灰区：字段全部合规，但描述含糊 —— 规则放行，模型该不该插手？
  { cat: 'meal', amount: 290, receipt: false, preApproved: false, label: 'approve',
    text: '餐饮 290 元，未超 500 无需发票，未超上限 300，用途写得很笼统（"业务需要"）' },
  { cat: 'supplies', amount: 210, receipt: false, preApproved: false, label: 'approve',
    text: '杂项采购 210 元，未超 500 无需发票，未超上限 800，明细未写' },
]

const OPTIONS = [
  'Approve this expense claim',
  'Do not approve it — it violates the policy or lacks required evidence',
]

async function askModel(c) {
  const state = [
    'Expense claim',
    `Category: ${c.cat}`,
    `Amount: ${c.amount} CNY`,
    `Receipt attached: ${c.receipt ? 'yes' : 'no'}`,
    `Prior approval obtained: ${c.preApproved ? 'yes' : 'no'}`,
    `Description: ${c.text}`,
    '',
    'Policy:',
    `- A receipt is required for any amount over ${POLICY.receiptRequiredOver} CNY.`,
    '- Category caps: meal 300, taxi 200, hotel 1200, supplies 800 CNY.',
    `- Prior approval is required over ${POLICY.priorApprovalOver} CNY.`,
  ].join('\n')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state,
      questions: [{ id: 'v', type: 'choice', options: OPTIONS,
                    instructions: 'Choose the option that is true of this claim.' }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  return { approve: d.answers?.v === 0, pReject: (d.option_scores?.v ?? [])[1] }
}

/** A) 纯规则：可查字段全部合规 -> approve；任一违规 -> reject；规则读不懂 -> 需人工 */
function ruleCheck(c) {
  const violations = []
  if (c.amount > POLICY.receiptRequiredOver && !c.receipt) violations.push('no receipt over 500')
  const cap = POLICY.caps[c.cat]
  if (cap !== undefined && c.amount > cap) violations.push(`over ${c.cat} cap ${cap}`)
  if (c.amount > POLICY.priorApprovalOver && !c.preApproved) violations.push('over 2000 without prior approval')
  if (violations.length) return { verdict: 'reject', why: violations.join('; ') }
  // 无违规：字段齐全时规则可以放心放行
  return { verdict: 'approve', why: 'no rule violated' }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
const N_REJECT = CLAIMS.filter((c) => c.label === 'reject').length
const N_APPROVE = CLAIMS.length - N_REJECT
console.log(`claims  : ${CLAIMS.length}`
  + ` (${N_REJECT} should be rejected, ${N_APPROVE} approved)\n`)

// ---- B) 纯模型 ----
console.log('=== B) pure model ===')
const modelRows = []
for (const c of CLAIMS) {
  const m = await askModel(c)
  const got = m.approve ? 'approve' : 'reject'
  modelRows.push({ c, got, pReject: m.pReject })
  const ok = got === c.label
  console.log(`  ${ok ? 'ok  ' : 'MISS'} want=${c.label.padEnd(8)} got=${got.padEnd(8)} `
    + `P(reject)=${(m.pReject ?? NaN).toFixed(3)}  ${c.text.slice(0, 44)}`)
}
const mBadApproved = modelRows.filter((r) => r.c.label === 'reject' && r.got === 'approve').length
const mGoodRejected = modelRows.filter((r) => r.c.label === 'approve' && r.got === 'reject').length
console.log(`  -> let through ${mBadApproved}/${N_REJECT} that should be rejected;`
  + ` rejected ${mGoodRejected}/${N_APPROVE} that were fine`)

// ---- A) 纯规则 ----
console.log('\n=== A) pure rule ===')
const ruleRows = CLAIMS.map((c) => ({ c, ...ruleCheck(c) }))
for (const r of ruleRows) {
  const got = r.verdict
  const ok = got === r.c.label || (got === 'manual' && r.c.label === 'approve')
  console.log(`  ${ok ? 'ok  ' : 'note'} rule=${got.padEnd(8)} truth=${r.c.label.padEnd(8)} ${r.why}`)
}
const rBadApproved = ruleRows.filter((r) => r.c.label === 'reject' && r.verdict === 'approve').length
const rGoodRejected = ruleRows.filter((r) => r.c.label === 'approve' && r.verdict === 'reject').length
const rManual = ruleRows.filter((r) => r.verdict === 'manual').length
console.log(`  -> let through ${rBadApproved}/${N_REJECT} that should be rejected;`
  + ` rejected ${rGoodRejected}/${N_APPROVE} that were fine; sent ${rManual} to manual review`)

// ---- C) 规则先定夺，灰区才问模型 ----
console.log('\n=== C) rule first, model only for what the rule cannot decide ===')
console.log(`  (in this set every claim has complete fields, so the rule decides all ${CLAIMS.length};`)
console.log('   the grey zone here is about *description* vagueness, which the rule ignores)')
const cBadApproved = ruleRows.filter((r) => r.c.label === 'reject' && r.verdict === 'approve').length
const cGoodRejected = ruleRows.filter((r) => r.c.label === 'approve' && r.verdict === 'reject').length
console.log(`  -> let through ${cBadApproved}/${N_REJECT} that should be rejected;`
  + ` rejected ${cGoodRejected}/${N_APPROVE} that were fine; model calls needed: 0/${CLAIMS.length}`)

console.log('\n=== verdict ===')
console.log(`  pure rule : ${cBadApproved} bad approved, ${cGoodRejected} good rejected, 0 model calls`)
console.log(`  pure model: ${mBadApproved} bad approved, ${mGoodRejected} good rejected, ${CLAIMS.length} model calls`)
if (cBadApproved < mBadApproved || (cBadApproved === mBadApproved && cGoodRejected <= mGoodRejected)) {
  console.log('  The rule layer is at least as good here AND needs no model calls, which is the')
  console.log('  whole argument for putting the rule first. The model adds nothing to this set;')
  console.log('  the grey zone it was supposed to handle never became a decision it had to make.')
} else {
  console.log('  The model beat the rule on this set — worth understanding before choosing either.')
}
