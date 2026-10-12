/**
 * measure-snake.mjs — 测 S12「贪吃蛇」：144.3M 参数当"蛇脑"能不能玩。
 *
 * gallery 标注：144.3M 参数的「蛇脑」21.0ms（RTX 5090）/步玩贪吃蛇。
 *
 * 这是 27 个演示里**唯一有客观、单一胜负判据**的：蛇吃到多少食物、活了多久。
 * 不需要标注集，也不需要我来判断对错 —— 环境自己给分。所以它的结果最难争辩。
 *
 * 方法：自己实现一个确定性的贪吃蛇环境（种子固定，无随机性），然后让三种策略玩，
 * 同一个种子跑同样的局：
 *
 *   random  —— 在三个合法动作里随机（下界）
 *   greedy  —— 朝食物走，撞墙/撞自己就换一个合法动作（不求最优的简单启发式）
 *   model   —— 把局面描述成文本、三个选项（直行/左转/右转），交给 /v1/systemone
 *
 * 判据：吃到的食物数。如果 model 不高于 random，那"蛇脑"这个说法在这套环境下不成立。
 * 另外记录每步时延与模型给出的置信度，供与 S11 / S06 的结论对照。
 *
 * Run: node docs/measure-snake.mjs [games]
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'

const GRID = 8
const MAX_STEPS = 200
const GAMES = Number(process.argv[2] || 3)

// 固定种子序列，保证三种策略面对**完全一样**的棋局序列
const SEEDS = [12345, 67890, 24680, 13579, 97531]

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 方向：0=上 1=右 2=下 3=左 */
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]

function newGame(seed) {
  const rand = rng(seed)
  const snake = [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }]
  const occupied = new Set(snake.map((p) => `${p.x},${p.y}`))
  let food
  do {
    food = { x: Math.floor(rand() * GRID), y: Math.floor(rand() * GRID) }
  } while (occupied.has(`${food.x},${food.y}`))
  return { snake, food, dir: 1, rand, steps: 0, eaten: 0, dead: false }
}

function occupiedSet(g) {
  return new Set(g.snake.map((p) => `${p.x},${p.y}`))
}

function isDead(g, dir, ignoreTail = true) {
  const [dx, dy] = DIRS[dir]
  const head = g.snake[0]
  const nx = head.x + dx
  const ny = head.y + dy
  if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) return true
  const body = g.snake.slice(0, ignoreTail ? g.snake.length - 1 : g.snake.length)
  return body.some((p) => p.x === nx && p.y === ny)
}

function step(g, dir) {
  if (isDead(g, dir)) { g.dead = true; return }
  g.dir = dir
  const [dx, dy] = DIRS[dir]
  const head = g.snake[0]
  const nx = head.x + dx
  const ny = head.y + dy
  g.snake.unshift({ x: nx, y: ny })
  if (nx === g.food.x && ny === g.food.y) {
    g.eaten += 1
    const occ = occupiedSet(g)
    const free = []
    for (let x = 0; x < GRID; x += 1) {
      for (let y = 0; y < GRID; y += 1) {
        if (!occ.has(`${x},${y}`)) free.push({ x, y })
      }
    }
    if (free.length === 0) { g.dead = true; return }
    g.food = free[Math.floor(g.rand() * free.length)]
  } else {
    g.snake.pop()
  }
  g.steps += 1
  if (g.steps >= MAX_STEPS) g.dead = true
}

/** 动作编码：0=直行 1=右转 2=左转（相对当前朝向） */
const ACTIONS = [
  (d) => d,                    // 直行
  (d) => (d + 1) % 4,          // 右转
  (d) => (d + 3) % 4,          // 左转
]

function safeActions(g) {
  return [0, 1, 2].filter((a) => !isDead(g, ACTIONS[a](g.dir)))
}

function legalMove(g, action) {
  const d = ACTIONS[action](g.dir)
  if (isDead(g, d)) {
    // 该动作立刻致命：退回到任一安全动作；没有安全动作就按原样走（必死）
    const safe = safeActions(g)
    return safe.length ? ACTIONS[safe[0]](g.dir) : d
  }
  return d
}

async function modelAction(g) {
  const head = g.snake[0]
  const rel = (p) => ({ x: p.x - head.x, y: p.y - head.y })
  const f = rel(g.food)
  const state = [
    `Grid ${GRID}x${GRID}. Snake head at (0,0) is the frame of reference;`,
    `positive x is right and positive y is down.`,
    `Snake length ${g.snake.length}. Food is at (${f.x},${f.y}).`,
    `The snake is moving ${['up', 'right', 'down', 'left'][g.dir]}.`,
    `Body cells relative to the head: `
      + g.snake.slice(1, 6).map((p) => { const r = rel(p); return `(${r.x},${r.y})` }).join(' '),
    safeActions(g).length === 1
      ? 'Only one of the three options avoids immediate death.'
      : '',
  ].filter(Boolean).join('\n')

  const options = [
    'continue straight ahead',
    'turn right, then move forward',
    'turn left, then move forward',
  ]
  const t0 = process.hrtime.bigint()
  const res = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'Phocinae-Largha-150M-v1', state,
      questions: [{ id: 'mv', type: 'choice', options,
                    instructions: 'Choose the move that keeps the snake alive and heads for the food.' }],
    }),
  })
  const text = await res.text()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  const d = JSON.parse(text)
  const idx = d.answers?.mv
  const p = d.option_scores?.mv ?? []
  return { action: typeof idx === 'number' ? idx : 0, conf: p[idx] ?? 0, ms }
}

function play(strategy, seed) {
  const g = newGame(seed)
  return { g, seed }
}

async function run(strategy, seed) {
  const g = newGame(seed)
  const lat = []
  while (!g.dead) {
    let action
    if (strategy === 'random') {
      const safe = safeActions(g)
      const pool = safe.length ? safe : [0, 1, 2]
      action = pool[Math.floor(g.rand() * pool.length)]
    } else if (strategy === 'greedy') {
      const head = g.snake[0]
      const dx = g.food.x - head.x
      const dy = g.food.y - head.y
      const wanted = Math.abs(dx) >= Math.abs(dy)
        ? (dx > 0 ? 1 : dx < 0 ? 3 : (dy > 0 ? 2 : 0))
        : (dy > 0 ? 2 : 0)
      action = [0, 1, 2].find((a) => ACTIONS[a](g.dir) === wanted)
      if (action === undefined || isDead(g, ACTIONS[action](g.dir))) {
        const safe = safeActions(g)
        action = safe.length ? safe[0] : 0
      }
    } else {
      const m = await modelAction(g)
      lat.push(m.ms)
      action = m.action
    }
    step(g, legalMove(g, action))
  }
  return { eaten: g.eaten, steps: g.steps, len: g.snake.length, lat }
}

try {
  const r = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`phocinae-server unreachable: ${e.message}`)
  process.exit(2)
}

console.log(`endpoint: ${ENDPOINT}`)
console.log(`grid ${GRID}x${GRID}, max ${MAX_STEPS} steps, ${GAMES} games per strategy, fixed seeds\n`)

const results = { random: [], greedy: [], model: [] }
for (let i = 0; i < GAMES; i += 1) {
  const seed = SEEDS[i % SEEDS.length]
  for (const s of ['random', 'greedy', 'model']) {
    const out = await run(s, seed)
    results[s].push(out)
  }
  const r0 = results.random[i]; const g0 = results.greedy[i]; const m0 = results.model[i]
  console.log(`  seed ${seed}:  random ${String(r0.eaten).padStart(2)} food / ${String(r0.steps).padStart(3)} steps`
    + `   greedy ${String(g0.eaten).padStart(2)} / ${String(g0.steps).padStart(3)}`
    + `   model ${String(m0.eaten).padStart(2)} / ${String(m0.steps).padStart(3)}`)
}

const sum = (a, k) => a.reduce((s, x) => s + x[k], 0)
const avg = (a, k) => sum(a, k) / a.length

console.log('\n=== totals ===')
for (const s of ['random', 'greedy', 'model']) {
  const a = results[s]
  console.log(`  ${s.padEnd(7)} food ${String(sum(a, 'eaten')).padStart(3)}`
    + `   steps ${String(sum(a, 'steps')).padStart(4)}`
    + `   avg length ${avg(a, 'len').toFixed(1)}`)
}

const mid = results.model.flatMap((r) => r.lat)
if (mid.length) {
  const sorted = [...mid].sort((x, y) => x - y)
  console.log(`\n  model per-step latency: n=${sorted.length}`
    + `  p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms`
    + `  max ${sorted[sorted.length - 1].toFixed(1)} ms`)
}

console.log('\n=== verdict ===')
const rf = sum(results.random, 'eaten')
const gf = sum(results.greedy, 'eaten')
const mf = sum(results.model, 'eaten')
console.log(`  random ${rf} · greedy ${gf} · model ${mf}`)
if (mf <= rf) {
  console.log('  The model does not beat random play. As a snake policy on this environment it')
  console.log('  adds nothing, so the "snake brain" demo does not carry over to the wire protocol.')
} else if (mf < gf) {
  console.log('  The model beats random but not the trivial greedy heuristic, so it is not a')
  console.log('  competitive policy here — it is a demonstration that the model emits a decision.')
} else {
  console.log('  The model matches or beats greedy on this environment.')
}
