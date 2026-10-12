/**
 * measure-bilingual.mjs — 测 S23「双语并排」（gallery 标注 en 0.906 / zh 0.848）。
 *
 * 为什么这一族值得单独测：和 S22 一样，它主要是一个**内部一致性**主张 ——
 * 同一道判定用中英两种语言各问一次，答案应该指向同一个语义选项。这件事不需要
 * 人工标注就能测，而且**跨语言不一致无法被辩解为"我的样本有偏"**：如果同一件
 * 事情用中文问和用英文问得到不同结论，那调用方连"该用哪种语言"都无从决定。
 *
 * 方法：12 条判定，每条给出**语义等价**的中英题面与同一组（各自语言书写但一一
 * 对应的）选项。判据：
 *   * 一致率：两种语言选出的**语义选项**是否同一个
 *   * 各自准确率：与构造时确定的正确答案比较
 *   * 用英文答对、用中文答错（或反之）的比例 —— 这才是"语言在决定答案"的证据
 *
 * 翻译原则：逐字对应，不为了"更自然"而改动信息量；选项顺序在两种语言里保持一致，
 * 以免把顺序效应误记成语言效应（S22 已证明顺序会改变答案）。
 *
 * Run: node docs/measure-bilingual.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

// correct 用 0/1/2 的下标表示（两种语言的选项顺序严格一致）
const CASES = [
  {
    en: 'The build failed on Windows but passed on Linux.',
    zh: '构建在 Windows 上失败，但在 Linux 上通过。',
    enOpts: ['check the Windows-specific code path',
             'mark the test as flaky and move on',
             'disable the test on Windows'],
    zhOpts: ['检查 Windows 特有的代码路径',
             '把这个测试标记为不稳定，先跳过',
             '在 Windows 上禁用这个测试'],
    correct: 0,
  },
  {
    en: 'A customer was charged twice for a single order.',
    zh: '一位客户为一个订单被扣了两次款。',
    enOpts: ['refund the duplicate charge',
             'ask the customer to wait',
             'close the ticket'],
    zhOpts: ['退还重复扣款的那一笔',
             '请客户等待',
             '关闭工单'],
    correct: 0,
  },
  {
    en: 'The API TLS certificate expires in three days.',
    zh: 'API 的 TLS 证书还有三天过期。',
    enOpts: ['renew the certificate now',
             'wait for it to expire',
             'turn off TLS'],
    zhOpts: ['立即续期证书',
             '等它过期',
             '关闭 TLS'],
    correct: 0,
  },
  {
    en: 'The nightly backup has failed four nights in a row.',
    zh: '每日备份已经连续四个晚上失败。',
    enOpts: ['investigate the backup failure',
             'ignore it for now',
             'delete the backup job'],
    zhOpts: ['排查备份失败的原因',
             '暂时忽略',
             '删除这个备份任务'],
    correct: 0,
  },
  {
    en: 'The primary database host is at 96% disk usage.',
    zh: '主数据库主机的磁盘使用率已达 96%。',
    enOpts: ['archive data or add capacity',
             'do nothing',
             'restart the host'],
    zhOpts: ['归档数据或扩容',
             '不做处理',
             '重启主机'],
    correct: 0,
  },
  {
    en: 'Checkout latency rose from 180ms to 1.4s.',
    zh: '结算接口延迟从 180 毫秒上升到 1.4 秒。',
    enOpts: ['profile the endpoint for a regression',
             'leave it as is',
             'raise the client timeout'],
    zhOpts: ['对接口做性能分析，查找回归',
             '保持现状',
             '调大客户端超时'],
    correct: 0,
  },
  {
    en: 'A dependency has a published security advisory.',
    zh: '某个依赖发布了安全公告。',
    enOpts: ['upgrade to a fixed version',
             'pin the vulnerable version',
             'remove the dependency entirely'],
    zhOpts: ['升级到已修复的版本',
             '锁定在有漏洞的版本',
             '彻底移除这个依赖'],
    correct: 0,
  },
  {
    en: 'Staging has drifted from the infrastructure definition.',
    zh: '预发环境与基础设施定义已经不一致。',
    enOpts: ['reapply the definition',
             'change production to match staging',
             'delete the staging environment'],
    zhOpts: ['重新应用那份定义',
             '把生产环境改成和预发一致',
             '删除预发环境'],
    correct: 0,
  },
  {
    en: 'Two services both write to the same database table.',
    zh: '两个服务都在写同一张数据库表。',
    enOpts: ['decide on a single owner and document it',
             'let both keep writing',
             'drop the table'],
    zhOpts: ['确定唯一的归属方并记录下来',
             '让两边继续写',
             '删掉这张表'],
    correct: 0,
  },
  {
    en: 'The test suite takes 22 minutes on every push.',
    zh: '每次推送都要跑 22 分钟的测试。',
    enOpts: ['split the suite so the fast tests run first',
             'stop running tests on push',
             'delete the slow tests'],
    zhOpts: ['拆分测试集，让快的先跑',
             '取消推送时跑测试',
             '删掉那些慢的测试'],
    correct: 0,
  },
  {
    en: 'An alert fired once and did not repeat.',
    zh: '一条告警触发了一次，之后没有再出现。',
    enOpts: ['check whether it mattered and record the finding',
             'silence the alert permanently',
             'page the on-call engineer'],
    zhOpts: ['确认它是否有影响，并记录结论',
             '永久屏蔽这条告警',
             '呼叫值班工程师'],
    correct: 0,
  },
  {
    en: 'A user requests a feature that already exists.',
    zh: '一位用户请求一个已经存在的功能。',
    enOpts: ['point them at the existing feature',
             'build the duplicate anyway',
             'close the request without replying'],
    zhOpts: ['告诉他已有这个功能',
             '照样再做一个重复的',
             '不回复直接关闭请求'],
    correct: 0,
  },
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
  return { idx: d.answers?.v, p: d.option_scores?.v ?? [] }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
console.log(`cases   : ${CASES.length} (each asked once in English and once in Chinese)\n`)

let agree = 0
let enRight = 0
let zhRight = 0
let enOnly = 0
let zhOnly = 0
let bothWrong = 0
const rows = []

for (const c of CASES) {
  const en = await ask(c.en, c.enOpts)
  const zh = await ask(c.zh, c.zhOpts)
  const same = en.idx === zh.idx
  const enOk = en.idx === c.correct
  const zhOk = zh.idx === c.correct
  if (same) agree += 1
  if (enOk) enRight += 1
  if (zhOk) zhRight += 1
  if (enOk && !zhOk) enOnly += 1
  if (!enOk && zhOk) zhOnly += 1
  if (!enOk && !zhOk) bothWrong += 1
  rows.push({ c, en, zh, same, enOk, zhOk })

  const tag = same ? 'agree' : 'DIFFER'
  console.log(`  [${tag}] ${c.en.slice(0, 46)}`)
  console.log(`      en idx=${en.idx} ${enOk ? '(correct)' : '(wrong)  '}   `
    + `zh idx=${zh.idx} ${zhOk ? '(correct)' : '(wrong)'}`)
}

console.log('\n=== agreement ===')
console.log(`  same semantic option chosen : ${agree}/${CASES.length}`
  + `  (disagreement ${(1 - agree / CASES.length).toFixed(3)})`)

console.log('\n=== accuracy by language ===')
console.log(`  English correct : ${enRight}/${CASES.length} = ${(enRight / CASES.length * 100).toFixed(0)}%`)
console.log(`  Chinese correct : ${zhRight}/${CASES.length} = ${(zhRight / CASES.length * 100).toFixed(0)}%`)
console.log(`  gallery states  : en 0.906 / zh 0.848`)

console.log('\n=== where the language changed the outcome ===')
console.log(`  correct in English but wrong in Chinese : ${enOnly}/${CASES.length}`)
console.log(`  wrong in English but correct in Chinese : ${zhOnly}/${CASES.length}`)
console.log(`  wrong in both                           : ${bothWrong}/${CASES.length}`)

console.log('\n=== verdict ===')
const disagreeRate = 1 - agree / CASES.length
if (disagreeRate <= 0.05) {
  console.log('  The two languages agree on this sample; a caller can pick either.')
} else if (disagreeRate <= 0.25) {
  console.log(`  Disagreement ${(disagreeRate * 100).toFixed(0)}%: high enough that a caller has to pick one`)
  console.log('  language deliberately and stay with it, rather than assuming parity.')
} else {
  console.log(`  Disagreement ${(disagreeRate * 100).toFixed(0)}%: the language is deciding the answer,`)
  console.log('  not just the content. The two are not interchangeable.')
}
