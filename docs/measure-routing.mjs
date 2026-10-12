/**
 * measure-routing.mjs — 测「选择」类决策点（gallery S07 工具路由 / S16 技能路由）。
 *
 * 为什么单独测这一类：前面测的全是**质量判断**（"这段上下文重要吗"、"这张发票
 * 自洽吗"）。而路由是**选择**：候选集合固定、其中恰好一个是对的。这类问题在
 * 结构上更容易 —— 模型不需要有一个"重要性"的内部标尺，只需要把请求和候选做
 * 匹配。gallery 给 S07 的标注是「工具选择 12/12」，如果属实，这是唯一可能
 * 直接达标的演示族。
 *
 * 判定用"命中率"而不是危险侧错误：路由选错会浪费一次调用，但不会静默放行
 * 危险操作，所以门槛可以比安全类低一些 —— 但也不能低到"不如随机"。
 *
 * Run: node docs/measure-routing.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

// ---- 12 条请求 + 候选工具集；每条恰好一个正确答案 ----
const TOOLS = [
  'read_file', 'write_file', 'run_shell', 'search_web',
  'query_database', 'send_email', 'create_calendar_event', 'summarise_text',
]

const CASES = [
  { want: 'read_file', text: 'Show me what is in config/settings.py.' },
  { want: 'write_file', text: 'Save these three paragraphs to notes.md.' },
  { want: 'run_shell', text: 'Run the test suite and tell me if anything failed.' },
  { want: 'search_web', text: 'What is the current population of Reykjavik?' },
  { want: 'query_database', text: 'How many orders were placed last Tuesday?' },
  { want: 'send_email', text: 'Tell the vendor that we accept their quote.' },
  { want: 'create_calendar_event', text: 'Book a 30 minute call with Dana on Thursday at 14:00.' },
  { want: 'summarise_text', text: 'Give me a two sentence version of this 40 page report.' },
  { want: 'read_file', text: 'Open the changelog and find the entry for version 2.1.' },
  { want: 'run_shell', text: 'Which processes are listening on port 8155?' },
  { want: 'search_web', text: 'Who won the 2026 world championship?' },
  { want: 'query_database', text: 'List the customers who have not ordered in 90 days.' },
]

async function route(text, options) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state: text,
      questions: [{
        id: 'v', type: 'choice', options,
        instructions: 'Choose the one option that best serves this request.',
      }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  const idx = d.answers?.v
  const p = d.option_scores?.v ?? []
  return {
    idx,
    pick: options[idx],
    pPick: p[idx],
    // 正确选项排第几（用于看位置偏置）
    correctIdx: idx,
    topP: p.length ? Math.max(...p) : NaN,
  }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
console.log(`candidates: ${TOOLS.length} tools; cases: ${CASES.length}\n`)

// ---- 1) 完整候选集（8 选 1），同 gallery S07 的设定 ----
console.log('=== A) full candidate set (8 options, one correct) ===')
let hits = 0
const perCase = []
for (const c of CASES) {
  const r = await route(c.text, TOOLS)
  const ok = r.pick === c.want
  if (ok) hits += 1
  perCase.push({ ...c, ...r, ok })
  console.log(`  ${ok ? 'ok  ' : 'MISS'} want=${c.want.padEnd(22)} got=${String(r.pick).padEnd(22)} `
    + `p(pick)=${(r.pPick ?? NaN).toFixed(3)}  ${c.text.slice(0, 52)}`)
}
console.log(`  -> ${hits}/${CASES.length} correct (random baseline = ${(CASES.length / TOOLS.length).toFixed(2)}/12)`)

// ---- 2) 位置偏置：把正确选项轮换到每个位置，看命中率是否随之变化 ----
console.log('\n=== B) position bias — rotate the correct option through each slot ===')
const slotStats = []
for (let slot = 0; slot < TOOLS.length; slot += 1) {
  let sHit = 0
  for (const c of CASES) {
    // 构造一份 8 元候选：把正确答案放在 slot，其余位置填别的工具（不重复）
    const others = TOOLS.filter((t) => t !== c.want)
    const opts = []
    let oi = 0
    for (let i = 0; i < TOOLS.length; i += 1) {
      if (i === slot) opts.push(c.want)
      else { opts.push(others[oi]); oi += 1 }
    }
    const r = await route(c.text, opts)
    if (r.pick === c.want) sHit += 1
  }
  const acc = sHit / CASES.length
  slotStats.push({ slot, acc })
  console.log(`  correct at slot ${slot}: ${sHit}/${CASES.length} = ${(acc * 100).toFixed(0)}%`)
}

// ---- 3) 二选一：正确选项 vs 一个强干扰项 ----
console.log('\n=== C) two options: the right tool vs a plausible distractor ===')
const DISTRACTOR = {
  read_file: 'summarise_text', write_file: 'run_shell', run_shell: 'write_file',
  search_web: 'query_database', query_database: 'search_web', send_email: 'create_calendar_event',
  create_calendar_event: 'send_email', summarise_text: 'read_file',
}
let cHit = 0
for (const c of CASES) {
  const d = DISTRACTOR[c.want]
  const flip = Math.random() < 0.5
  const opts = flip ? [d, c.want] : [c.want, d]
  const r = await route(c.text, opts)
  const ok = r.pick === c.want
  if (ok) cHit += 1
  console.log(`  ${ok ? 'ok  ' : 'MISS'} want=${c.want.padEnd(22)} got=${String(r.pick).padEnd(22)} p=${(r.pPick ?? NaN).toFixed(3)}`)
}
console.log(`  -> ${cHit}/${CASES.length} correct (random baseline = 6/12)`)

console.log('\n=== verdict ===')
console.log(`  8-way routing : ${hits}/${CASES.length} = ${((hits / CASES.length) * 100).toFixed(0)}%  (gallery S07 claims 12/12)`)
console.log(`  2-way routing : ${cHit}/${CASES.length} = ${((cHit / CASES.length) * 100).toFixed(0)}%`)
const spread = Math.max(...slotStats.map((s) => s.acc)) - Math.min(...slotStats.map((s) => s.acc))
console.log(`  position spread across the 8 slots: ${(spread * 100).toFixed(0)} points`)
if (hits === CASES.length) {
  console.log('  PERFECT on the 8-way set — routing is the one family that meets its bar.')
} else if (hits / CASES.length >= 0.75) {
  console.log('  Usable as a first pass, but it must not be the only router: verify the pick.')
} else {
  console.log('  NOT usable as a router: a wrong tool call costs more than the decision saves.')
}
