/**
 * measure-escalation-savings.mjs — 测 S06「升级门省费」/ G26「token 省费」的经济性。
 *
 * gallery 标注：τ=0.6 升级门，大模型调用 **−55.0%**（τ=0.5 档 79.6%），
 * acc 0.906→0.9936 (kept subset)。
 *
 * 那个数字背后的机制是：**置信度低的才升级给大模型，高的就在本地定**。
 * 所以能不能省，取决于置信度能不能把"该升级的"和"能本地定的"分开：
 *
 *   * 如果模型对所有输入都给相似的高置信度，那么按阈值区分就分不出东西 ——
 *     要么全本地（不省调用但本地判定可能错），要么全升级（省不了）。
 *   * 只有当置信度与"本地是否答对"相关时，门才能既省调用又不降低准确率。
 *
 * 本脚本不去重测"准确率"（前面九族已经测过），而是直接测**置信度是否可用**：
 * 对每一族已测的数据，扫描阈值 τ，算出
 *   升级率 = P(置信度 < τ)      —— 越小越省
 *   本地子集的准确率             —— 省下来的代价
 * 如果"本地子集准确率"在各种 τ 下都不高于整体，或升级率始终接近 1，
 * 那么省费的说法在真实协议调用下不成立。
 *
 * Run: node docs/measure-escalation-savings.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

/** 每组：state + 选项 + 正确下标。沿用 measure-routing 与 measure-bilingual 的语料。 */
const GROUPS = {
  'routing (S07/S16, 3 tools)': [
    { s: 'Show me what is in config/settings.py.', o: ['read_file', 'write_file', 'run_shell'], c: 0 },
    { s: 'Run the test suite and tell me if anything failed.', o: ['run_shell', 'read_file', 'write_file'], c: 0 },
    { s: 'How many orders were placed last Tuesday?', o: ['query_database', 'send_email', 'search_web'], c: 0 },
    { s: 'Tell the vendor that we accept their quote.', o: ['send_email', 'summarise_text', 'run_shell'], c: 0 },
    { s: 'Book a 30 minute call with Dana on Thursday at 14:00.', o: ['create_calendar_event', 'send_email', 'query_database'], c: 0 },
    { s: 'Give me a two sentence version of this 40 page report.', o: ['summarise_text', 'read_file', 'search_web'], c: 0 },
    { s: 'What is the current population of Reykjavik?', o: ['search_web', 'query_database', 'read_file'], c: 0 },
    { s: 'List the customers who have not ordered in 90 days.', o: ['query_database', 'search_web', 'send_email'], c: 0 },
  ],
  'bilingual zh (S23)': [
    { s: '一位客户为一个订单被扣了两次款。', o: ['退还重复扣款的那一笔', '请客户等待', '关闭工单'], c: 0 },
    { s: '每日备份已经连续四个晚上失败。', o: ['排查备份失败的原因', '暂时忽略', '删除这个备份任务'], c: 0 },
    { s: '结算接口延迟从 180 毫秒上升到 1.4 秒。', o: ['对接口做性能分析，查找回归', '保持现状', '调大客户端超时'], c: 0 },
    { s: '某个依赖发布了安全公告。', o: ['升级到已修复的版本', '锁定在有漏洞的版本', '彻底移除这个依赖'], c: 0 },
    { s: '两个服务都在写同一张数据库表。', o: ['确定唯一的归属方并记录下来', '让两边继续写', '删掉这张表'], c: 0 },
    { s: '一条告警触发了一次，之后没有再出现。', o: ['确认它是否有影响，并记录结论', '永久屏蔽这条告警', '呼叫值班工程师'], c: 0 },
    { s: '每次推送都要跑 22 分钟的测试。', o: ['拆分测试集，让快的先跑', '取消推送时跑测试', '删掉那些慢的测试'], c: 0 },
    { s: '一位用户请求一个已经存在的功能。', o: ['告诉他已有这个功能', '照样再做一个重复的', '不回复直接关闭请求'], c: 0 },
  ],
}

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
  const p = d.option_scores?.v ?? []
  const idx = d.answers?.v
  return {
    idx,
    correct: idx === 0,
    // 置信度 = 所选选项的概率（与 /v1/systemone 的 answer_confidence 同口径）
    conf: typeof idx === 'number' && p[idx] !== undefined ? p[idx] : 0,
    top: p.length ? Math.max(...p) : 0,
  }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}\n`)

const all = []
for (const [name, cases] of Object.entries(GROUPS)) {
  console.log(`=== ${name} ===`)
  for (const c of cases) {
    const a = await ask(c.s, c.o)
    all.push({ group: name, ...a })
    console.log(`  ${a.correct ? 'ok  ' : 'MISS'} conf=${a.conf.toFixed(3)} top=${a.top.toFixed(3)}`
      + `  ${c.s.slice(0, 46)}`)
  }
  console.log('')
}

const overall = all.filter((a) => a.correct).length / all.length
console.log(`overall accuracy: ${all.filter((a) => a.correct).length}/${all.length}`
  + ` = ${(overall * 100).toFixed(0)}%`)

// 置信度分布
const confs = all.map((a) => a.conf).sort((x, y) => x - y)
console.log(`\nconfidence distribution (chosen option's probability):`)
console.log(`  min ${confs[0].toFixed(3)}  p25 ${confs[Math.floor(confs.length * 0.25)].toFixed(3)}`
  + `  median ${confs[Math.floor(confs.length / 2)].toFixed(3)}`
  + `  p75 ${confs[Math.floor(confs.length * 0.75)].toFixed(3)}  max ${confs[confs.length - 1].toFixed(3)}`)
console.log(`  spread (max-min): ${(confs[confs.length - 1] - confs[0]).toFixed(3)}`)

// 关键判据：置信度能否区分"答对"与"答错"
const rightC = all.filter((a) => a.correct).map((a) => a.conf)
const wrongC = all.filter((a) => !a.correct).map((a) => a.conf)
const mean = (x) => x.reduce((s, v) => s + v, 0) / (x.length || 1)
console.log(`\nmean confidence when correct : ${mean(rightC).toFixed(3)}  (n=${rightC.length})`)
console.log(`mean confidence when wrong   : ${mean(wrongC).toFixed(3)}  (n=${wrongC.length})`)

console.log(`\n=== threshold sweep: keep locally when confidence >= t ===`)
console.log('     t   kept   escalated   local accuracy   escalated accuracy')
for (const t of [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]) {
  const kept = all.filter((a) => a.conf >= t)
  const esc = all.filter((a) => a.conf < t)
  const kAcc = kept.length ? kept.filter((a) => a.correct).length / kept.length : NaN
  const eAcc = esc.length ? esc.filter((a) => a.correct).length / esc.length : NaN
  console.log(`  ${t.toFixed(2)}   ${String(kept.length).padStart(2)}/${all.length}`
    + `      ${String(esc.length).padStart(2)}/${all.length}`
    + `        ${Number.isNaN(kAcc) ? '  n/a' : (kAcc * 100).toFixed(0).padStart(4) + '%'}`
    + `             ${Number.isNaN(eAcc) ? '  n/a' : (eAcc * 100).toFixed(0).padStart(4) + '%'}`)
}

console.log('\n=== verdict ===')
const at60 = all.filter((a) => a.conf >= 0.60)
const escRate60 = 1 - at60.length / all.length
const localAcc60 = at60.length ? at60.filter((a) => a.correct).length / at60.length : 0
console.log(`  gallery states: tau=0.6 gate cuts LLM calls by 55.0% (tau=0.5: 79.6%)`)
console.log(`  at t=0.60 this set escalates ${(escRate60 * 100).toFixed(1)}% of decisions`)
console.log(`  and the locally-kept subset is ${(localAcc60 * 100).toFixed(0)}% accurate`
  + ` (overall ${(overall * 100).toFixed(0)}%)`)
const confUseful = mean(rightC) > mean(wrongC) + 0.05
if (!confUseful) {
  console.log('\n  Confidence does NOT separate correct from incorrect answers here: the')
  console.log('  means differ by less than 0.05. An escalation gate built on it would')
  console.log('  either escalate nearly everything (no saving) or keep nearly everything')
  console.log('  (no accuracy gain). The saving depends on this separation existing.')
} else {
  console.log('\n  Confidence does separate the two groups on this set, so a gate could work;')
  console.log('  the sweep above shows the trade-off to pick from.')
}
