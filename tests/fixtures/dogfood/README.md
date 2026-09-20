# Dogfood dry run notes

Two headless runs against this repo, invoking the un-namespaced
`spine review --diff` form (before the `/spine:spine` prefix requirement was
discovered — see Runs 4 to 6 below), with an uncommitted trailing-blank-line
change to `README.md`. Both were launched the same way:

```
claude -p --plugin-dir C:/Users/rassi/spine --permission-mode acceptEdits \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Skill,Agent" \
  --output-format text "spine review --diff"
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

## Run 3 (at commit `3370422`, after the final-review fix wave) — size M

Same launch command as before, with `Workflow` added to `--allowedTools`,
against an uncommitted whitespace change to five files under `scripts/` so
the classifier returns size M. Bootstrap, classification, the M-sized
workflow, records, and the G3 gate all worked:

- Class M (5 files, blast radius normal).
- `review.workflow.js` ran both `ecc:code-review` and
  `mattpocock-skills:code-review`: six findings (three INFO, three LOW),
  none CRITICAL/HIGH, so verify and the devil's-advocate gate did not fire.
- R-0007 is the synthesis record (no formal dissent); R-0008 is the
  standalone boundary-checker PASS (no upstream).
- `review.json` verdict `PASS_WITH_ADVISORIES`, `state.json` ended
  `awaiting: "G3"`, summary block rendered before stopping for approval.

`hooks.log` recorded one real in-session Stop-gate block that was then
satisfied, three subagent allows, and PostToolUse around each write:

```
2026-09-20T07:39:26.248Z PostToolUse ok
2026-09-20T07:40:17.198Z Stop block
2026-09-20T07:41:45.312Z SubagentStop allow
2026-09-20T07:45:01.037Z SubagentStop allow
2026-09-20T07:45:45.658Z PostToolUse ok
2026-09-20T07:45:48.529Z PostToolUse ok
2026-09-20T07:45:51.379Z PostToolUse ok
2026-09-20T07:45:54.636Z PostToolUse ok
2026-09-20T07:46:00.103Z PostToolUse ok
2026-09-20T07:46:06.360Z PostToolUse ok
2026-09-20T07:48:09.862Z SubagentStop allow
2026-09-20T07:48:28.144Z PostToolUse ok
2026-09-20T07:48:29.945Z PostToolUse ok
2026-09-20T07:48:43.466Z PostToolUse ok
2026-09-20T07:48:48.517Z PostToolUse ok
```

## Not verified

- `SessionStart` hook output — still not directly observed: `-p
  --output-format text` doesn't surface hook stderr/stdout, and run 3's
  `hooks.log` has no `SessionStart` line either, since that hook fires
  before a run exists and the log only starts once one does.
- The L classification path, `spec.workflow.js`, `implement.workflow.js`,
  and the devil's-advocate gate — unexercised; runs 1-3 only reached sizes
  S and M in the review stage.

## Runs 4 to 6 (PR #1 review)

Three more headless runs, this time targeting PR #1 via the review entry
point.

- **Run 4** — launched without `MSYS_NO_PATHCONV=1`. Git Bash rewrote the
  leading-slash argument — `/spine`, followed by `review 1` — into a
  filesystem path before Claude saw it, so the process picked up the
  still-active run from Run 3 instead and answered about that stale review
  rather than PR #1.
- **Run 5** — launched with `MSYS_NO_PATHCONV=1` set, avoiding the path
  rewrite. Claude answered `Unknown command: /spine`, which is what exposed
  that plugin slash commands are namespaced by plugin: the real command is
  `/spine:spine review 1`, not the un-prefixed `spine review 1`.
- **Run 6** — launched `/spine:spine review 1`. Classified PR #1 as size L
  (61 files, devils advocate on), bootstrapped run `20260920-review-pr-1`,
  and launched the review workflow with three providers. Hit the 600 second
  headless background ceiling (`Background tasks still running after 600s;
  terminating.`) and exited cleanly with `awaiting: human` and no
  `review.json` written. `hooks.log` recorded one `Stop block` and two
  `SubagentStop allow`. Run 7 repeats it with the ceiling disabled (result
  recorded separately).
