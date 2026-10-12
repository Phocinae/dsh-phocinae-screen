/**
 * measure-deterministic-first.mjs — 对"规则形状"的决策点做实测。
 *
 * 背景：可行性矩阵已经证明，六个纯靠模型的决策点全部不达标（其中对照组的
 * 命令门单独用时只有 55%）。但 gallery 里有些演示的判定**本身是算术/规则**，
 * 模型只该处理灰区 —— S18 发票校验就是典型：金额 × 税率 == 税额 是逐分可算的。
 *
 * 那么真正该问的问题是：这类决策点上，**加一个确定性层之后**能不能达标？
 * 本脚本对三种形态分别测量：
 *
 *   A) 纯规则        —— 只做算术/日期比较，完全不问模型
 *   B) 纯模型        —— 把整段文本交给模型判"一致/不一致"
 *   C) 规则 + 模型灰区 —— 规则能定的直接定，歧义的才问模型
 *
 * 判定标准是"危险侧错误"：把不一致的发票判成一致（漏检）比把一致的判成不一致
 * 严重得多 —— 前者会让错误付款通过，后者只是多一次人工核对。
 *
 * Run: node docs/measure-deterministic-first.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

// ---- 样本：12 张发票，6 张内部一致、6 张不一致（不一致方式各不相同） ----
const SAMPLES = [
  { label: 'consistent', net: 1200.00, rate: 0.19, tax: 228.00, total: 1428.00,
    note: '净额 1200.00 × 19% = 228.00，合计 1428.00，三处自洽' },
  { label: 'consistent', net: 500.00, rate: 0.06, tax: 30.00, total: 530.00,
    note: '净额 500.00 × 6% = 30.00，合计 530.00' },
  { label: 'consistent', net: 2840.50, rate: 0.13, tax: 369.27, total: 3209.77,
    note: '含分位进位：2840.50 × 13% = 369.265 → 369.27，合计 3209.77' },
  { label: 'consistent', net: 99.99, rate: 0.19, tax: 19.00, total: 118.99,
    note: '99.99 × 19% = 18.9981 → 19.00，合计 118.99' },
  { label: 'consistent', net: 10000.00, rate: 0.25, tax: 2500.00, total: 12500.00,
    note: '整额' },
  { label: 'consistent', net: 76.30, rate: 0.06, tax: 4.58, total: 80.88,
    note: '76.30 × 6% = 4.578 → 4.58，合计 80.88' },

  { label: 'inconsistent', net: 1200.00, rate: 0.19, tax: 200.00, total: 1400.00,
    note: '税额算错：应为 228.00，写成 200.00（合计数也跟着错）' },
  { label: 'inconsistent', net: 500.00, rate: 0.06, tax: 30.00, total: 560.00,
    note: '税额对，但合计算错：应为 530.00' },
  { label: 'inconsistent', net: 2840.50, rate: 0.13, tax: 369.27, total: 3000.00,
    note: '税额对，合计被抹成整数' },
  { label: 'inconsistent', net: 99.99, rate: 0.19, tax: 19.00, total: 118.00,
    note: '合计差一分（118.99 vs 118.00）' },
  { label: 'inconsistent', net: 10000.00, rate: 0.25, tax: 2000.00, total: 12000.00,
    note: '税率用错：按 20% 而非 25% 算税' },
  { label: 'inconsistent', net: 76.30, rate: 0.06, tax: 4.58, total: 90.88,
    note: '合计多写 10.00' },
]

const fmt = (n) => n.toFixed(2)

/** A) 纯规则：逐分核对 净额×税率==税额 且 净额+税额==合计。 */
function ruleCheck(s) {
  const expectTax = Math.round(s.net * s.rate * 100) / 100
  const expectTotal = Math.round((s.net + expectTax) * 100) / 100
  const taxOk = Math.abs(expectTax - s.tax) < 0.005
  const totalOk = Math.abs(expectTotal - s.total) < 0.005
  return { consistent: taxOk && totalOk, expectTax, expectTotal, taxOk, totalOk }
}

/** 把发票渲染成一段文本，供模型阅读。 */
function render(s) {
  return [
    'Invoice',
    `Net amount: ${fmt(s.net)}`,
    `VAT rate: ${(s.rate * 100).toFixed(0)}%`,
    `VAT amount: ${fmt(s.tax)}`,
    `Total: ${fmt(s.total)}`,
  ].join('\n')
}

async function modelCheck(s) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state: render(s),
      questions: [{
        id: 'v', type: 'choice',
        options: [
          'The amounts are internally consistent: the VAT is the net times the rate and the total is the net plus the VAT',
          'The amounts are not consistent',
        ],
        instructions: 'Choose the option that is true of this invoice.',
      }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  const p = d.option_scores?.v ?? []
  return { consistent: d.answers?.v === 0, pNotConsistent: p[1], conf: d.answer_confidence?.v }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
console.log(`samples : ${SAMPLES.length} (6 consistent / 6 inconsistent)\n`)

console.log('=== A) pure rule (arithmetic only, no model) ===')
let aTp = 0; let aTn = 0; let aFp = 0; let aFn = 0
for (const s of SAMPLES) {
  const got = ruleCheck(s).consistent ? 'consistent' : 'inconsistent'
  const ok = got === s.label
  if (s.label === 'inconsistent') { if (got === 'inconsistent') aTp += 1; else aFn += 1 } else if (got === 'consistent') aTn += 1; else aFp += 1
  console.log(`  ${ok ? 'ok  ' : 'MISS'} want=${s.label.padEnd(12)} got=${got.padEnd(12)} ${s.note}`)
}
console.log(`  -> caught ${aTp}/6 problems, ${aFn} missed, ${aFp} false alarms`)

console.log('\n=== B) pure model (no arithmetic layer) ===')
let bTp = 0; let bTn = 0; let bFp = 0; let bFn = 0
const modelRows = []
for (const s of SAMPLES) {
  const m = await modelCheck(s)
  const got = m.consistent ? 'consistent' : 'inconsistent'
  const ok = got === s.label
  if (s.label === 'inconsistent') { if (got === 'inconsistent') bTp += 1; else bFn += 1 } else if (got === 'consistent') bTn += 1; else bFp += 1
  modelRows.push({ s, m, got })
  console.log(`  ${ok ? 'ok  ' : 'MISS'} want=${s.label.padEnd(12)} got=${got.padEnd(12)} `
    + `P(inconsistent)=${m.pNotConsistent === undefined ? 'n/a' : m.pNotConsistent.toFixed(3).padStart(5)}  ${s.note}`)
}
console.log(`  -> caught ${bTp}/6 problems, ${bFn} missed, ${bFp} false alarms`)

// ---- C) 规则先定，剩下才问模型 ----
// 规则以"逐分核对"为准：不一致 = 确定不一致（直接拦）；一致 = 确定一致（直接放）。
// 真实系统里规则只在"字段齐全且金额可解析"时才敢下定论，这里全部可解析，
// 所以 C 的判定与 A 相同 —— 重点是把"灰区"空出来给模型，而不是让它重复劳动。
console.log('\n=== C) rule first, model only for the grey zone ===')
console.log('  (all 12 samples have complete, parseable amounts, so the rule decides every one)')
console.log(`  -> caught ${aTp}/6 problems, ${aFn} missed, ${aFp} false alarms`)
console.log(`  -> model calls avoided: 12/${SAMPLES.length} (0 grey-zone cases in this set)`)

console.log('\n=== verdict ===')
console.log(`  pure rule   : ${aTp}/6 caught, ${aFn} missed, ${aFp} false alarms`)
console.log(`  pure model  : ${bTp}/6 caught, ${bFn} missed, ${bFp} false alarms`)
const ruleWins = aFn <= bFn && aFp <= bFp
console.log(ruleWins
  ? '  A deterministic arithmetic layer is at least as good as the model here, and it is'
    + '\n  explainable to the cent. Ship the rule; use the model only for quantities the'
    + '\n  rule cannot read.'
  : '  The model beats the rule here, which needs explaining before anyone ships either.')

// 灰区样本：金额以文字描述、无法直接解析 —— 这才是模型该处理的形态。
console.log('\n=== grey zone: amounts described in prose (the rule cannot parse these) ===')
const GREY = [
  { label: 'inconsistent', text: 'The invoice lists a net of twelve hundred euro with nineteen percent VAT, and states a total of fourteen hundred euro.' },
  { label: 'consistent', text: 'The invoice lists a net of five hundred euro with six percent VAT and a total of five hundred and thirty euro.' },
]
for (const g of GREY) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state: g.text,
      questions: [{
        id: 'v', type: 'choice',
        options: ['The stated amounts are internally consistent',
          'The stated amounts are not consistent'],
        instructions: 'Choose the option that is true.',
      }],
    }),
  })
  const d = await res.json()
  const got = d.answers?.v === 0 ? 'consistent' : 'inconsistent'
  console.log(`  ${got === g.label ? 'ok  ' : 'MISS'} want=${g.label.padEnd(12)} got=${got.padEnd(12)} `
    + `P(no)=${(d.option_scores?.v?.[1] ?? NaN).toFixed(3)}`)
}
