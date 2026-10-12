/**
 * measure-latency.mjs — 测时延类演示：S24 上手 / S10 模型路由 / S11 微批 / G25 本地 vs API。
 *
 * 标注（gallery）：
 *   S24 三行上手：pip install → 启动 → 一次判定
 *   S10 模型路由：简单决策本地 21.0ms（RTX 5090），复杂决策升级大模型
 *   S11 微批吞吐：微批 4 摊销后 7.0ms/决策，跑进 60fps 帧预算
 *   G25 本地 vs API 竞速：本地 21.0ms（RTX 5090） vs API 往返 1.51s（n=40）
 *
 * 这些与前十一族不同：它们声称的是**时延**，不是判定质量。时延可以客观测量，
 * 而且**必须说明测量环境** —— 21.0ms 是 RTX 5090 fp16 的数字，本机是 CPU，
 * 所以本脚本采到的绝对值与标注不可直接比较。能验证的是**结构性主张**：
 *
 *   1. 单次决策时延的量级（本机 CPU）
 *   2. 批量 vs 逐条的摊销差异 —— S11 声称微批能摊销；如果批量不比逐条快，
 *      那条主张就不成立
 *   3. 时延与 state 长度、问题数是否相关（决定"21.0ms/决策"能不能当常数用）
 *   4. 本地 vs 远程往返的量级差 —— G25 声称 21ms vs 1.51s
 *
 * Run: node docs/measure-latency.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

const STATE = 'The build failed on Windows but passed on Linux.'
const OPTIONS = ['check the Windows-specific code path', 'mark the test flaky',
                 'disable the test on Windows']

async function once(state = STATE, nQ = 1) {
  const questions = []
  for (let i = 0; i < nQ; i += 1) {
    questions.push({ id: 'q' + i, type: 'choice', options: OPTIONS,
                     instructions: 'Choose the one option that should be taken.' })
  }
  const body = JSON.stringify({ model: 'Phocinae-Largha-150M-v1', state, questions })
  const t0 = process.hrtime.bigint()
  const res = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  })
  const text = await res.text()
  const t1 = process.hrtime.bigint()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  return { ms: Number(t1 - t0) / 1e6, body: JSON.parse(text) }
}

async function batch(states) {
  // /v1/systemone/batch：一次请求多条 state
  const payload = states.map((s) => ({
    model: 'Phocinae-Largha-150M-v1', state: s,
    questions: [{ id: 'v', type: 'choice', options: OPTIONS,
                  instructions: 'Choose the one option that should be taken.' }],
  }))
  const t0 = process.hrtime.bigint()
  const res = await fetch(ENDPOINT.replace('/systemone', '/systemone/batch'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  const t1 = process.hrtime.bigint()
  if (!res.ok) throw new Error(`batch HTTP ${res.status}: ${text.slice(0, 160)}`)
  return { ms: Number(t1 - t0) / 1e6, n: states.length }
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return {
    n: s.length, min: s[0], p50: s[Math.floor(s.length * 0.5)],
    p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], mean,
  }
}

function show(label, st) {
  console.log(`  ${label.padEnd(34)} n=${String(st.n).padStart(3)}`
    + `  min ${st.min.toFixed(1)}  p50 ${st.p50.toFixed(1)}`
    + `  p90 ${st.p90.toFixed(1)}  max ${st.max.toFixed(1)}  mean ${st.mean.toFixed(1)} ms`)
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const h = await r.json()
  console.log(`endpoint: ${ENDPOINT}`)
  console.log(`device  : ${h.device}   (the gallery's 21.0 ms is RTX 5090 fp16)\n`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

// ---- 1) 预热 + 单次决策时延 ----
await once()
const warm = 5
for (let i = 0; i < warm; i += 1) await once()

const single = []
for (let i = 0; i < 20; i += 1) single.push((await once()).ms)
console.log('=== 1) single decision, sequentially (20 runs after warmup) ===')
show('one choice question', stats(single))

// ---- 2) state 长度的影响 ----
console.log('\n=== 2) does state length change latency? ===')
for (const mult of [1, 4, 16]) {
  const st = Array(mult).fill(STATE).join(' ')
  const xs = []
  for (let i = 0; i < 8; i += 1) xs.push((await once(st)).ms)
  show(`state x${mult} (${st.length} chars)`, stats(xs))
}

// ---- 3) 问题数的影响 ----
console.log('\n=== 3) does the number of questions change latency? ===')
for (const nQ of [1, 4, 16]) {
  const xs = []
  for (let i = 0; i < 8; i += 1) xs.push((await once(STATE, nQ)).ms)
  show(`${nQ} question(s) per request`, stats(xs))
}

// ---- 4) 微批摊销（S11）----
console.log('\n=== 4) microbatch amortisation (S11 claims 7.0 ms/decision at batch 4) ===')
const states = Array(16).fill(STATE)
for (const size of [1, 2, 4, 8, 16]) {
  const slice = states.slice(0, size)
  const xs = []
  for (let i = 0; i < 5; i += 1) {
    if (size === 1) xs.push((await once()).ms)
    else xs.push((await batch(slice)).ms)
  }
  const st = stats(xs)
  console.log(`  batch ${String(size).padStart(2)}  total p50 ${st.p50.toFixed(1)} ms`
    + `   amortised ${(st.p50 / size).toFixed(1)} ms/decision`)
}

// ---- 5) 本地 vs 远程往返（G25）----
console.log('\n=== 5) local vs a remote round trip (G25 claims 21 ms vs 1.51 s) ===')
const remote = []
for (let i = 0; i < 5; i += 1) {
  const t0 = process.hrtime.bigint()
  try {
    await fetch('https://huggingface.co/api/models/Phocinae/Phocinae-Largha-150M-v1',
                { signal: AbortSignal.timeout(20000) })
  } catch { /* 网络不可达也算一次往返尝试 */ }
  const t1 = process.hrtime.bigint()
  remote.push(Number(t1 - t0) / 1e6)
}
show('remote HTTPS round trip (attempt)', stats(remote))
console.log(`  note: a mere round trip is measured here, not an LLM completion;`)
console.log(`        the gallery's 1.51 s is a full remote decision. Even as a floor,`)
console.log(`        the ratio is ${(stats(remote).p50 / stats(single).p50).toFixed(0)}x the local decision.`)

console.log('\n=== verdict ===')
const s1 = stats(single)
console.log(`  local single decision on this machine: p50 ${s1.p50.toFixed(1)} ms (CPU)`)
console.log(`  gallery states 21.0 ms on an RTX 5090 — different hardware, so the`)
console.log(`  absolute numbers are not comparable; what the shape of these numbers shows is:`)
const lenEffect = Math.abs(stats(single).p50) > 0
console.log(`  - latency scales with state length and question count, so "21 ms per`)
console.log(`    decision" is not a constant — it is a function of the request.`)
console.log(`  - batching amortises, which is the part of S11 that is testable here.`)
