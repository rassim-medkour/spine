# Dogfood dry run notes

Two headless runs of `/spine review --diff` against this repo, with an
uncommitted trailing-blank-line change to `README.md`. Both were launched
the same way:

```
claude -p --plugin-dir C:/Users/rassi/spine --permission-mode acceptEdits \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Skill,Agent" \
  --output-format text "/spine review --diff"
```

## Run 1 (at commit `0f89855`) — found defects

Classification and provider selection were right (size S, low blast radius,
`ecc:code-review`), but the process itself broke down: no run was
bootstrapped before analysis (no `class.json`, `state.json`, or
`.spine/<id>/` was ever written), and instead of just running the review,
the orchestrator stopped to ask whether to skip it as "overkill for a
whitespace-only change." Skipping review is not a decision to defer to the
user — size S with no CRITICAL/HIGH surface still runs, it just yields an
INFO-only record. Fixed in `07589ea` (bootstrap before analysis, never skip
review) and `6f7558c` (bootstrap only when starting a run, so re-entrant
calls don't double-bootstrap).

## Run 2 (at commit `07589ea`) — passed end to end

Bootstrap, classification, provider selection, records, and the G3 gate all
worked. The run wrote:

```
.spine/20260920-review-readme-diff/class.json
.spine/20260920-review-readme-diff/records/R-0001.json
.spine/20260920-review-readme-diff/records/R-0002.json
.spine/20260920-review-readme-diff/records/R-0003.json
.spine/20260920-review-readme-diff/review.json
.spine/20260920-review-readme-diff/state.json
.spine/active.json
```

Size S, low blast radius, so the single-provider inline path ran (no
cross-provider workflow): `ecc:code-review` reviewed the diff directly.
R-0001 is the one finding (INFO — trailing blank line, no functional
change), R-0002 is the standalone boundary-checker PASS record (no upstream
artifact to compare against), R-0003 is the synthesis (1 consensus, 0
dissent). `review.json` landed with verdict `PASS_WITH_ADVISORIES`,
`state.json` ended `awaiting: "G3"`, and the turn rendered the fixed summary
block before stopping for approval:

```
NEXT: Say "approve" to close run 20260920-review-readme-diff, or raise anything on R-0001.
STATE: stage 4/5 review · run 20260920-review-readme-diff · 1 finding synthesized, verdict PASS_WITH_ADVISORIES
DONE:
1. Bootstrapped run, classified diff (size S, blast_radius low) — class.json.
2. Selected provider `ecc:code-review` (size S → 1 provider), ran inline review of README.md diff.
3. Wrote R-0001 (INFO, trailing blank line at README.md:74, no functional change), no CRITICAL/HIGH so no verifier dispatched.
4. Wrote R-0002 (boundary-checker PASS, standalone review, no upstream) and R-0003 (synthesis: 1 consensus, 0 dissent).
5. Wrote review.json, verdict PASS_WITH_ADVISORIES.
WHY:
1. Size S per class.json → inline single-provider path, no workflow (SKILL.md review/S rule) — R-0001.
2. No verifier dispatched: rule only requires verifying CRITICAL/HIGH, finding is INFO — review.json.
3. Devils advocate off: class.json devils_advocate=false — no dissent gate triggered.
DEBATED: none — single finding, no competing claim, resolution: none
DISSENT: none, gate not triggered
```

## Stop-gate mechanical check

Against the live `20260920-review-readme-diff` run, bypassing the skill:
with `review.json` removed and `state.json`'s `awaiting` set to `null`,
`node scripts/stop-gate.js` exited 2 with a one-line block reason; with
`review.json` restored, the same command exited 0 — matches section 10.

## Not verified

- `SessionStart` hook output — `-p --output-format text` doesn't surface
  hook stderr/stdout, so the missing-dependency warning went unobserved.
- M/L classification and the multi-provider cross-review workflow they
  trigger — both runs classified as size S.
