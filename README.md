# dsh-phocinae-screen — NOT FOR RELEASE

> **Status: do not publish.** This package implements an offline context screen
> for DeepSeek Harness (gallery demos S09 and S20). It is complete, its 31 unit
> tests and 11 live tests pass, and it works exactly as designed. It is not
> released because **the model cannot perform the decision it depends on**, and a
> screen built on it would silently delete context that mattered.
>
> The measurement is in [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) — and its
> §4 follow-up in [`docs/FEASIBILITY-deterministic.md`](docs/FEASIBILITY-deterministic.md),
> which tests the "add a deterministic rule in front" idea on a rule-shaped
> decision point (invoice arithmetic, gallery S18). The rule scored 6/6 with no
> false alarms; the model scored 0/6, calling every inconsistent invoice
> consistent. Raw output is in `docs/evidence/`.

## The short version

The screen asks the model to score each block of context on a 2–10 relevance
scale, then drops the low scorers. Measured against a real
`phocinae-server` with the released `Phocinae-Largha-150M-v1` weights:

- The 2–10 **score** question returns 2–3 for *every* block, under four different
  rubrics — including one that quotes the task verbatim. `answer_confidence` sits
  at ≈0.15. It carries no signal.
- **`noul`** shows pure positional bias: asked "is this needed" everything answers
  false, and asked "can this be removed" everything also answers false.
- A balanced 2-option **`choice`** does separate — and is what the screen is built
  on — but with severe overlap. Mean P(needed) is 0.594 for blocks that are needed
  and 0.448 for filler, where a working model would be near 0.9 and 0.1. A block
  containing the actual bug fix scored **0.323 (droppable)**; a nursery rhyme
  scored **0.691 (needed)**.

No boundary gives both zero false drops and meaningful savings. The best safe
boundary removes 2 of 6 filler blocks; the boundary that removes 10 of 12 drops a
needed block first.

## What is still worth keeping

The engineering is sound and the measuring tools are reusable:

- `lib/screen.mjs` — block splitting with recoverable offsets, the keep/drop
  decision with an uncertain middle band that is **kept** rather than dropped,
  drop-ratio guards, and digests that let any removal be audited.
- `lib/hook.mjs` — a `tools/post-execute` listener that replaces model-facing
  content only (the canonical `value` is untouched, so nothing is truly lost) and
  passes results through with an explicit "not screened" note when the service is
  down instead of blocking a tool call that succeeded.
- `docs/measure-screen.mjs`, `docs/feasibility-matrix.mjs`,
  `docs/measure-deterministic-first.mjs` and `docs/measure-routing.mjs` — the
  labelled-set harness, one script per decision-point family. Point them at a
  calibrated head and the same scripts will say whether it is good enough. Across
  all four families measured so far (screening, classification, rule-shaped
  arithmetic, routing) the answer is no, and the scripts are what says so.

If a calibrated head for this domain ever exists, this package is the plugin to
point it at. `docs/FEASIBILITY.md` §6 lists what would change the answer;
`docs/FEASIBILITY-deterministic.md` and `docs/FEASIBILITY-routing.md` are the
follow-ups for the two families that looked most likely to pass and did not.

## Running the checks

```bash
npm test                                        # 31 unit tests, offline
node test/live.test.mjs                         # 11 checks against a real server
node docs/feasibility-matrix.mjs                # the measurement behind the verdict
node docs/measure-deterministic-first.mjs       # S18 invoice arithmetic: rule 6/6, model 0/6
node docs/measure-routing.mjs                   # S07/S16 routing: 2/12 of 8-way, position-biased
```

`test/live.test.mjs` exits 2 when no service is reachable, so "not run" is never
reported as a pass.

## License

Apache-2.0, unchanged from the rest of the Phocinae plugins.
