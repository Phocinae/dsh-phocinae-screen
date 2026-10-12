/**
 * probe-question-types.mjs — when `score` gives no signal, do `choice` or `noul`?
 *
 * Context: probe-discrimination.mjs showed the 2-10 score question returns 2-3 for
 * every block regardless of content and regardless of rubric, with confidence
 * ~0.15. That is noise, so the shipped screen's foundation was wrong. Before
 * giving up on the capability, test the other two question types the model
 * actually reports accuracy for (typed acc en 0.906 is measured on classification).
 *
 * Run: node tools/probe-question-types.mjs
 */
const ENDPOINT = process.env.PHOC_SERVER || 'http://127.0.0.1:8155/v1/systemone'
const TASK = 'Find the cause of the failing refund test and the fix.'

const BLOCKS = {
  'answers-directly': 'Answer: the bug is in RefundCalculator.sum(). It filters on '
    + 'status in ("paid", "cancelled") but the test expects cancelled orders to be '
    + 'excluded, so the filter should be status == "paid".',
  'task-relevant': 'Task: the failing test asserts that refund totals exclude cancelled '
    + 'orders. Result: RefundCalculator.sum() adds every order with status paid OR '
    + 'cancelled, so a cancelled order is counted twice.',
  'generic-filler': 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '
    + 'tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis '
    + 'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'unrelated-log': 'GET /static/app.css 200 1.2ms\nGET /static/app.js 200 3.4ms\n'
    + 'GET /favicon.ico 404 0.3ms\nGET /static/logo.svg 200 0.9ms\nGET /health 200 0.6ms\n',
  'near-duplicate': 'Task: the failing test asserts that refund totals exclude cancelled '
    + 'orders. Result: RefundCalculator.sum() adds every order with status paid OR '
    + 'cancelled, so a cancelled order is counted twice. (Second copy.)',
}
const NAMES = Object.keys(BLOCKS)

async function ask(text, questions) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Phocinae-Largha-150M-v1', state: text, questions }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  return { answers: d.answers, conf: d.answer_confidence, scores: d.option_scores }
}

function table(title, rows) {
  console.log(`\n${title}`)
  const width = Math.max(...NAMES.map((n) => n.length)) + 2
  for (const n of NAMES) console.log(`  ${n.padEnd(width)} ${rows[n]}`)
}

try {
  const res = await fetch(ENDPOINT.replace(/\/v1\/systemone$/, '/health'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (err) {
  console.error(`phocinae-server unreachable: ${err.message}`)
  process.exit(2)
}
console.log(`endpoint: ${ENDPOINT}\ntask    : ${TASK}`)

// ---------------------------------------------------------------- choice 2-way
{
  const rows = {}
  for (const n of NAMES) {
    const r = await ask(BLOCKS[n], [{
      id: 'verdict',
      type: 'choice',
      options: [
        `This block is needed to work on the task: ${TASK}`,
        'This block is not needed and can be removed before the task is worked on',
      ],
      instructions: 'Choose the option that is true of the block.',
    }])
    const idx = r.answers?.verdict
    rows[n] = `${idx === 0 ? 'NEEDED   ' : idx === 1 ? 'DROPPABLE' : `?(${idx})`}`
      + `  conf=${(r.conf?.verdict ?? 0).toFixed(3)}`
      + `  p=[${(r.scores?.verdict ?? []).map((x) => x.toFixed(2)).join(', ')}]`
  }
  table('choice — 2 options, "needed" first', rows)
}

// ---------------------------------------------------------------- choice 3-way
{
  const rows = {}
  for (const n of NAMES) {
    const r = await ask(BLOCKS[n], [{
      id: 'verdict',
      type: 'choice',
      options: ['essential', 'useful', 'irrelevant'],
      instructions: `How relevant is this block to the task "${TASK}"?`,
    }])
    const idx = r.answers?.verdict
    const label = ['essential', 'useful  ', 'irrelevant'][idx] ?? `?(${idx})`
    rows[n] = `${label}  conf=${(r.conf?.verdict ?? 0).toFixed(3)}`
      + `  p=[${(r.scores?.verdict ?? []).map((x) => x.toFixed(2)).join(', ')}]`
  }
  table('choice — 3 options essential/useful/irrelevant', rows)
}

// ---------------------------------------------------------------- noul
{
  const rows = {}
  for (const n of NAMES) {
    const r = await ask(BLOCKS[n], [{
      id: 'keep',
      type: 'noul',
      threshold: 0.5,
      instructions: `The block is needed to work on this task: ${TASK}`,
      criteria: {
        true: 'The block contains information the task needs.',
        false: 'The block is filler, a duplicate, or unrelated.',
      },
    }])
    const v = r.answers?.keep
    rows[n] = `${v === true ? 'KEEP' : v === false ? 'DROP' : `?(${v})`}`
      + `  conf=${(r.conf?.keep ?? 0).toFixed(3)}`
      + `  p=[${(r.scores?.keep ?? []).map((x) => x.toFixed(2)).join(', ')}]`
  }
  table('noul — "the block is needed" (true=keep)', rows)
}

// ---------------------------------------------------------------- noul, negated
{
  const rows = {}
  for (const n of NAMES) {
    const r = await ask(BLOCKS[n], [{
      id: 'drop',
      type: 'noul',
      threshold: 0.5,
      instructions: 'This block can be removed before the task is worked on.',
      criteria: {
        true: 'Removing it loses nothing the task needs.',
        false: 'Removing it would lose something the task needs.',
      },
    }])
    const v = r.answers?.drop
    rows[n] = `${v === true ? 'DROPPABLE' : v === false ? 'NEEDED   ' : `?(${v})`}`
      + `  conf=${(r.conf?.drop ?? 0).toFixed(3)}`
      + `  p=[${(r.scores?.drop ?? []).map((x) => x.toFixed(2)).join(', ')}]`
  }
  table('noul — "this block can be removed" (true=drop)', rows)
}

console.log('\nReading: a usable screen needs answers-directly/task-relevant on the keep side')
console.log('and generic-filler/unrelated-log on the drop side, with confidence above noise.')
