## Risk and reading map

- Is this trunk code? yes
- Wide downstream dependencies? no
- Gated behind a flag? no
- If it breaks: bad yes, instant rollback no plan
- Read yourself: 2 hunks, about 1 min (whole diff 1 min).
1. `src/lib/math.ts:1-2` · no proof
2. `src/app.ts:2-5` · no proof, trunk

## TL;DR

Baseline change for the absent product context proof.

## The problem, with an example

Before: no baseline existed.
After: one captured baseline.

## The design decision that shaped everything

Capture real 0.3.2 output, never a hand-written fixture.

## What changed

| Area | Files | Lines | Tier | What |
|---|---|---|---|---|
| `src` | 1 | +1 / -0 | trunk | 1 file(s), highest tier trunk: entry point: top-level index or app file |
| `src/lib` | 1 | +1 / -0 | branch | 1 file(s), highest tier branch: public interface: changes an exported declaration |

## Rollout / switch order

- Instant rollback: no plan
- No rollback or flag plan was recorded.

## Decisions to check

- Spec assumption: Baseline assumption one.

## How it was checked

- Reviewers: none recorded
- Findings: none above INFO; fixed in the review loop: 0
- Cross-author verification rounds: 0
- Verdict: PASS

## Not verified

- test_run: src/app.ts, src/lib/math.ts (no proof record)
- static_check: src/app.ts, src/lib/math.ts (no proof record)
- integration_or_runtime: src/app.ts, src/lib/math.ts (no proof record)
- rollback_or_flag_plan: src/app.ts (no ## Rollback section; looked in review.md, plan.md and rollback_plan records of this run; add one or run scripts/record-proof.js --run <run> --kind rollback_plan --from <file.md>)
- test_quality: src/app.ts (no proof record)
- live_verify skipped: no project verify skill covers the trunk files

## How to test

- No test command was recorded.
