/**
 * measure-quality-gate.mjs — 测 S17「质量门」（周报草稿初筛）。
 *
 * 为什么单独挑这个演示来测：它是 13 个未测演示里**唯一自己就声明不是终审**的 ——
 * gallery 原文标注是「廉价初筛，不做终审」（p(需重写)=0.61 黄标打回）。
 * 前面四次测量说明模型做不了"替用户下结论"的判定，但"便宜地筛掉明显不合格的"
 * 是另一回事：漏掉一份坏稿只是让它多留一轮，与静默删掉正确上下文、或放行危险
 * 命令的后果完全不同。所以这一族值得单独测量。
 *
 * 判据（与安全类不同，故意更宽）：
 *   * **坏稿召回率**必须高（漏掉坏稿 = 这道门没用）
 *   * 好稿误打回率要低（打回好稿 = 增加人工负担，但不至于出事）
 *   * 与 do-nothing（全部放行）比较：门必须真的筛掉东西
 *
 * Run: node docs/measure-quality-gate.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

// 12 份周报草稿：6 份不合格（各以不同方式不合格）、6 份合格
const DRAFTS = [
  { label: 'bad', why: '只有结论，没有任何内容',
    text: '本周周报\n\n本周进展顺利，一切按计划进行。\n\n下周继续推进。' },
  { label: 'bad', why: '全篇占位符未填',
    text: '本周周报\n\n1. 完成了 XXX 任务，进度 XX%\n2. 与 XXX 对接，待 XXX 确认\n3. 下周计划：XXX\n\n风险：XXX' },
  { label: 'bad', why: '流水账，无结论无影响',
    text: '本周周报\n\n周一开会。周二写代码。周三改了三个 bug。周四开会。\n周五提交了代码。就这样。' },
  { label: 'bad', why: '把计划写成已完成，无可验证结果',
    text: '本周周报\n\n已完成全部迁移工作，系统运行良好。\n（未提供任何指标、时间、验证方式）' },
  { label: 'bad', why: '通篇与工作无关',
    text: '本周周报\n\n这周天气不错，中午和同事吃了火锅，味道很好。\n周末打算去看电影。' },
  { label: 'bad', why: '只抱怨不陈述事实',
    text: '本周周报\n\n这周太糟糕了，各种问题，很难受，感觉做不下去。\n反正就是很乱。' },

  { label: 'good', why: '具体、有指标、有风险与下一步',
    text: '本周周报\n\n1. 订单服务迁移：完成 12/12 个接口，灰度 10% 流量，P99 从 480ms 降到 190ms\n'
      + '2. 修复线上问题 3 个（#4821 #4830 #4844），其中 #4830 是重复扣款，已回滚并补数据\n'
      + '3. 风险：新集群磁盘配额只剩 18%，需在周三前扩容\n'
      + '4. 下周：迁移剩余 90% 流量，补齐回滚演练' },
  { label: 'good', why: '有量化与明确结论',
    text: '本周周报\n\n- 推荐模型 A/B 实验结束：实验组 CTR +4.2%（p=0.03），采用实验组\n'
      + '- 数据管道延迟从 45min 降到 8min，重跑失败率 0.3%→0.1%\n'
      + '- 下周：把新特征接入线上，预计周三完成' },
  { label: 'good', why: '包含失败与应对，信息完整',
    text: '本周周报\n\n- 支付网关联调未按计划完成（原定周三，实际周五），原因是对端证书链缺失，已定位\n'
      + '- 已完成对账脚本，覆盖 98% 场景，剩余 2% 手工处理\n'
      + '- 风险：对端下周三才能提供新证书，可能影响上线窗口\n'
      + '- 下周：先上线不依赖证书那部分' },
  { label: 'good', why: '简短但每句都有事实',
    text: '本周周报\n\n- 发布 v2.3.1，包含 7 个修复，线上错误率 0.4%→0.05%\n'
      + '- 完成 Q4 容量评估：现有配置可支撑到 12 月中\n'
      + '- 下周：开始缓存层重构设计评审' },
  { label: 'good', why: '有数据、有决策、有后续',
    text: '本周周报\n\n- 成本优化：把冷数据转归档存储，月度账单预计从 $4,100 降到 $2,600\n'
      + '- 已完成 3 个客户 POC，其中 2 个进入商务流程\n'
      + '- 下周：与财务确认归档保留策略（合规要求 7 年）' },
  { label: 'good', why: '客观描述阻塞与已采取措施',
    text: '本周周报\n\n- 阻塞：上游 API 限流从 1000/min 收紧到 200/min，批处理任务积压 6 小时\n'
      + '- 已采取措施：改为分片重试 + 本地缓存，积压降到 40 分钟\n'
      + '- 下周：与上游申请提额，同时评估自建缓存层' },
]

const OPTIONS = [
  'This weekly report is complete enough to submit: it states concrete work, '
    + 'outcomes, and next steps',
  'This weekly report is not ready: it is missing substance and should be rewritten',
]

async function judge(text) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1',
      state: text,
      questions: [{ id: 'v', type: 'choice', options: OPTIONS,
                    instructions: 'Choose the option that is true of this draft.' }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  const p = d.option_scores?.v ?? []
  return { index: d.answers?.v, pNeedRewrite: p[1], conf: d.answer_confidence?.v }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
console.log(`drafts  : ${DRAFTS.length} (6 should be sent back, 6 are fine)\n`)

const rows = []
for (const d of DRAFTS) {
  const j = await judge(d.text)
  const sentBack = j.index === 1
  const want = d.label === 'bad'
  rows.push({ ...d, ...j, sentBack, correct: sentBack === want })
  const mark = sentBack === want ? 'ok  ' : 'MISS'
  console.log(`  ${mark} want=${(want ? 'rewrite' : 'ok').padEnd(8)} got=${(sentBack ? 'rewrite' : 'ok').padEnd(8)} `
    + `P(rewrite)=${(j.pNeedRewrite ?? NaN).toFixed(3)}  ${d.why}`)
}

const bad = rows.filter((r) => r.label === 'bad')
const good = rows.filter((r) => r.label === 'good')
const caught = bad.filter((r) => r.sentBack).length
const falseAlarm = good.filter((r) => r.sentBack).length
const correct = rows.filter((r) => r.correct).length

console.log('\n=== result ===')
console.log(`  bad drafts sent back  : ${caught}/${bad.length}  (recall ${(caught / bad.length * 100).toFixed(0)}%)`)
console.log(`  good drafts sent back : ${falseAlarm}/${good.length}  (false alarm ${(falseAlarm / good.length * 100).toFixed(0)}%)`)
console.log(`  overall               : ${correct}/${rows.length}`)

const badP = bad.map((r) => r.pNeedRewrite ?? 0).sort((a, b) => a - b)
const goodP = good.map((r) => r.pNeedRewrite ?? 0).sort((a, b) => a - b)
console.log(`  P(rewrite) bad drafts : ${badP.map((x) => x.toFixed(2)).join(' ')}`)
console.log(`  P(rewrite) good drafts: ${goodP.map((x) => x.toFixed(2)).join(' ')}`)

// 阈值扫描：以 P(rewrite) >= t 打回
console.log('\n=== threshold sweep (send back when P(rewrite) >= t) ===')
console.log('     t   caught   false alarms   total correct')
for (const t of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  const c = bad.filter((r) => (r.pNeedRewrite ?? 0) >= t).length
  const f = good.filter((r) => (r.pNeedRewrite ?? 0) >= t).length
  console.log(`  ${t.toFixed(2)}   ${String(c)}/${bad.length}          ${String(f)}/${good.length}`
    + `            ${c + (good.length - f)}/${rows.length}`)
}

console.log('\n=== verdict ===')
const baseline = `${good.length}/${rows.length} correct by doing nothing (send nothing back)`
console.log(`  do-nothing: ${baseline}`)
if (caught <= bad.length / 2) {
  console.log('  The gate misses most bad drafts: it is not a useful screen.')
} else if (falseAlarm > good.length / 2) {
  console.log('  The gate sends back most good drafts: it would cost more review time than it saves.')
} else {
  console.log(`  Usable as a pre-screen: caught ${caught}/${bad.length} bad drafts at the cost of`
    + ` ${falseAlarm} good ones. It must be presented as a screen, never as a verdict.`)
}
