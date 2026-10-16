---
name: spine
description: Orchestrates a gated, evidence-first engineering run. Classifies the task, routes it through intent, spec, plan, implement, and review with cross-provider agents, enforces artifact gates, and renders a fixed summary block. Entry points intent, adopt, implement, review, status, resume. Use when starting any non-trivial feature, ticket, or review.
---

# Spine

You are running the Spine process. Read this whole file before acting.

Plugin root: the directory three levels above this file (this file lives at
`<root>/cursor/skills/spine/SKILL.md`). Scripts live in `<root>/scripts/`.
You are running inside Cursor: there is no Workflow tool and no Skill tool.
Own agents are this plugin's Cursor subagents `boundary-checker`,
`devils-advocate` and `synthesis`; records still name them
`spine:boundary-checker`, `spine:devils-advocate`, `spine:synthesis`.
`spine:live-verify` is not an agent: it is the `agent` label on records you
write yourself while running [live verification](#live-verification).

Wherever this file names a provider such as `superpowers:writing-plans`, use
it only if `select-providers.js ... --host cursor` returned it or the
sessionStart context does not list its plugin as missing. Otherwise dispatch
a generic subagent with that provider's strengths pasted into the prompt and
say so in WHY.

Load the `record-contract` skill once per session before dispatching any
agent. Load `gap-check` when the instructions below say so.

## State you own

All artifacts for a run live in `<repo>/.spine/<id>/` (or the configured
`artifacts_dir`). Run id is `YYYYMMDD-<slug>` where slug is 2 to 4 lowercase
words joined by dashes. You are the only writer of:

- `.spine/active.json`: `{ "id": "<id>" }`
- `<run>/state.json`: `{ "id", "stage", "status", "awaiting", "size", "updated", "host", "spine_version" }`
  - `stage` is one of `intent`, `spec`, `plan`, `implement`, `review`, `done`.
  - `status` is `active`, `paused`, or `done`.
  - `awaiting` is `null`, `human`, `G1`, `G2`, or `G3`. Set it to the gate
    name in the same turn you ask that gate's question, and only then. Set
    it to `human` whenever a turn ends on a question to the human that is
    not a gate question, or on `/spine status`. Clear it back to `null` on
    the next turn. The Stop hook lets a turn end only when the stage
    artifact is valid and boundary-checked, or when `awaiting` is set.
    Never set `awaiting` to dodge a gate.
  - `updated` is an ISO 8601 timestamp; get it with `date -u +%Y-%m-%dT%H:%M:%SZ`
    (Bash) or `Get-Date -AsUTC -Format yyyy-MM-ddTHH:mm:ssZ` (PowerShell).
  - `host` is always `"cursor"` when you write it from Cursor. Write it on
    every state write. If `state.json` already says `"claude-code"`, say in
    one line that the run was last driven from Claude Code and that one host
    should drive a run at a time, then continue.
  - `spine_version` is the plugin version (`version` in `.claude-plugin/plugin.json`, for example `"0.3.0"`). Write it when you bootstrap a run, only if `state.json` has none; never change it later. A run with `spine_version` 0.3.0 or later that has no `tree.json` is `UNPROVEN` at review; a run without the field is a legacy run and keeps the v0.2.0 rules.
- `<run>/class.json`: output of `node <root>/scripts/classify.js`.
- `<run>/tree.json`, `<run>/diagnostics.json`, `<run>/classify.log`: written
  by `node <root>/scripts/tree.js --run <run> ...`, never by hand. tree.json
  holds each changed file's file tier (`trunk`, `branch` or `leaf`), its nine
  signals, the change tier (the highest file tier) and the four review-knob
  answers.
- `<run>/diff.patch` is the exact diff under review. `<run>/evidence/` holds
  proof payloads saved with `save-evidence.js`. `<run>/proof.json`,
  `<run>/reading-map.md` and `<run>/reading-map.json` are written by
  `check-proof.js` and `reading-map.js`. `<run>/pr-written.md` and
  `<run>/pr-body.md` hold the PR description (see "Opening a PR (after G3)").
- `<run>/records/R-NNNN.json`: one file per record. Get the next id by
  listing the directory; ids are zero-padded to four digits.
- Stage artifacts: `intent.md`, `spec.md`, `tickets.json`, `plan.md`,
  `review.json`. Their required headings and keys are in `<root>/schemas/`.
  The PostToolUse hook validates them on every write and tells you what is
  missing.

## Bootstrap comes first

This keys on whether the entry point starts a new run, not on its name.
There are three groups.

- Starting: `intent`, `adopt`, `review`. The FIRST actions of the turn,
  before reading any diff, classifying, or selecting providers, are: create
  the run directory, write `state.json` (stage set to the entry stage,
  status `active`, awaiting `null`), write `active.json`. If `active.json`
  already points at a different run whose `status` is `active`, say in one
  line which run is being superseded and that it can be reopened with
  `/spine resume <id>`, then bootstrap the new run. Never delete the
  old run directory.
- Continuing: `implement`, `status`. The FIRST action of the turn is reading
  `active.json` and `state.json`. If no active run exists, stop and tell the
  human to run `/spine adopt <plan>`, `/spine intent`, or
  `/spine resume <id>`. Do not create anything.
- Resuming: `resume <id>`. The FIRST action of the turn is checking that
  `<artifacts_dir>/<id>/state.json` exists. If it does, write `active.json`
  with that id and continue at the recorded stage. If it does not, stop and
  tell the human the run id is unknown. Never create a run directory here —
  `resume` points `active.json` at a run that already exists, including
  right after G3 deletes `active.json`.

## Records

Every subagent you dispatch ends its answer with one fenced block tagged
`json spine-record` per record. Never copy record JSON by hand: save the
subagent's answer to `<run>/tmp/<label>.md` and run
`node <root>/scripts/write-record.js <run> --from-text <run>/tmp/<label>.md --provider <id> --author <author> --host cursor`.
It validates each record against the record contract, assigns the next
`R-NNNN` id and writes `records/R-NNNN.json`. On a validation error it prints
the problems and writes nothing; fix the answer and rerun. A record with only
`unverified` evidence may not be HIGH or CRITICAL; downgrade or verify.

## Classification

Run once per run, and again at `review` if the diff changed the file set:

```bash
node <root>/scripts/classify.js --files <comma-separated changed or planned files> [--migration] [--new-subsystem]
```

Write the output to `<run>/class.json`. It decides:

| Field | Effect |
|---|---|
| `size` S | inline stages, one provider, no fan-out |
| `size` M | two providers from different authors, parallel fan-out in `implement` and `review` |
| `size` L | three providers, fan-out in `spec`, `implement` and `review`, council on the spec |
| `blast_radius` critical | security lens on, devils advocate on |
| `devils_advocate` true | pass `--devils-advocate true` to `da-gate.js` |
| `tier` trunk (from tree.js) | required proof adds a rollback or flag plan and the test-quality check; every trunk hunk is read-yourself |

Then compute the file tier of the same files:

```bash
node <root>/scripts/tree.js --run <run> --files <same comma-separated files>
```

It writes `<run>/tree.json`, copies the change tier into `class.json` as
`tier`, and prints `{ ok, tier, files, revision }`. Keep `revision`: every
proof record you write later carries it. If it prints `"disabled": true`, the
repo set `"risk_tiers": false`; skip every tree, proof, verdict and
reading-map step below and use the verdict rule exactly as v0.2.0 did. A run
started before this version has no tree.json and no `spine_version` and is handled the same way; a run that has `spine_version` 0.3.0 or later but no tree.json is `UNPROVEN`, so run tree.js.

Select providers per stage with:

```bash
node <root>/scripts/select-providers.js <stage> <size> --host cursor
```

Use the printed list for fan-out, and use it to decide which skills or
agents to invoke inline for size S.

### Fan-out on Cursor

Cursor has no Workflow tool. Size M and L stages fan out to parallel Cursor
subagents instead: start every independent subagent of a step in one message
(one Task call each) so they run in parallel, wait for all of them, then go
to the next step. Every subagent prompt includes the record contract rules
and ends with: "End your answer with one fenced block tagged
`json spine-record` per finding." Only implementer subagents may edit files.
Finders, verifiers, `boundary-checker`, `devils-advocate` and `synthesis` are
read-only. Fan-out never crosses a gate.

### When parallel subagents are unavailable

If you cannot start subagents (the Task tool is missing, or a subagent call
is refused or errors before it runs), do not stop the run and do not skip the
stage. Run that stage on the size S path instead: the first selected
provider inline, and for review, CRITICAL and HIGH findings verified by a
provider from a different author. Write one record from yourself with agent
`spine:orchestrator`, the current stage, claim
`workflow tool unavailable, ran inline`, evidence
`{ "kind": "unverified", "ref": "workflow-tool" }`, confidence 1, severity
`INFO`. Gates, boundary checks and the summary block are unchanged.

## Stages

```
intent -> classify -> [spec] -G1-> [plan] -G2-> [implement] -> [review] -G3-> done
```

Before every gate and before marking a stage done, dispatch
`spine:boundary-checker` with the upstream and downstream file paths and the
boundary name (`spec-vs-intent`, `plan-vs-spec`, `code-vs-plan`,
`tests-vs-acceptance`). Write its record. If the claim is not `PASS`, fix the
downstream artifact and re-run. The Stop hook enforces this.

### intent

1. Create the run directory, `state.json` with stage `intent`, and
   `active.json`.
2. Write `intent.md` with headings `## Problem`, `## Acceptance criteria`
   (numbered `AC-n`), `## Constraints`, `## Out of scope`. Use
   `ecc:intent-driven-development` to shape the criteria when size is M or L.
3. Load `gap-check` and apply it. Questions go to the human one per turn.
   Assumptions go under `## Assumptions`.
4. Classify. Write `class.json`. No boundary checker runs for intent (no
   upstream); instead write one record from yourself with agent
   `spine:boundary-checker`, stage `intent`, claim `PASS`, evidence
   `doc intent.md:1`, note "no upstream". Move stage to `spec`.

### spec

- Size S or M: draft `spec.md` yourself with headings `## Summary`,
  `## Requirements`, `## Design`, `## Error paths`, `## Data and migrations`,
  `## Test anchors`, `## Assumptions`, `## Out of scope`. For M, invoke the two
  selected spec providers first and fold their output in.
- Size L: fan out one read-only subagent per lens in `class.lenses`, in
  parallel. Each gets `intent.md`, its lens name and the selected spec
  providers' strengths, and returns requirements, risks, questions and
  assumptions as records. Merge them into `spec.md` and put each disagreement
  between lenses under a `## Open disagreements` heading with its resolution
  (`test`, `spike` or `question`). Then run `ecc:council` on the two most
  consequential disagreements if the ecc plugin is available in Cursor,
  otherwise the `devils-advocate` subagent.
- Add one Mermaid component or context diagram and one sequence diagram for
  the main flow under `## Design`.
- Run `gap-check`. Run the boundary checker `spec-vs-intent`.
- Gate G1: set `awaiting: "G1"`, render the summary block, ask the human to
  approve `spec.md`. Stop. On approval set `awaiting: null`, stage `plan`.

### plan

1. Invoke `superpowers:writing-plans` against `spec.md`. Save as `plan.md`
   with headings `## Goal` and `## Tasks`.
2. Write `tickets.json`: `{ "id", "upstream_id": "<spec id>", "tickets": [ { "id": "T-1", "title", "spec_section", "kind": "feature|fix|spike|test|question", "status": "todo", "acceptance": ["AC-1"], "files": [] } ] }`. Every unresolved dissent from the spec becomes a ticket of kind `spike`, `test`, or `question`.
3. Size L: invoke `mattpocock-skills:grilling` on the plan and record the
   answers as assumptions in `plan.md`.
4. Add a Mermaid dependency graph of tickets with the critical path marked.
5. Boundary checker `plan-vs-spec`. Gate G2: `awaiting: "G2"`, summary block,
   ask for approval. Stop. On approval `awaiting: null`, stage `implement`.

### implement

- Size S: dispatch one `general-purpose` implementer per ticket with the
  spec section, acceptance criteria, and TDD instructions from
  `superpowers:subagent-driven-development`; then one reviewer from the
  selected provider.
- Size M or L: for each ticket in order, start one implementer subagent with
  the ticket, its spec section, its acceptance criteria and TDD instructions
  (provider: the first entry of `select-providers.js implement <size> --host cursor`).
  When it returns, start two read-only reviewer subagents in parallel: a
  spec-compliance reviewer and a quality reviewer, drawn from
  `select-providers.js review <size> --host cursor`. Write every record. Mark
  each ticket `done` in `tickets.json` when the implementer reports it
  implemented and both reviews pass; otherwise `blocked` with the blockers
  listed in the ticket.
- Run [live verification](#live-verification) on the files the tickets
  changed.
- Boundary checker `code-vs-plan`, then `tests-vs-acceptance` with the test
  command from `plan.md`. Move stage to `review`.

### review

1. Bootstrap the run (see above).
2. Compute the diff: `git diff <base>...HEAD` for a branch, `gh pr diff <n>`
   for a PR, `git diff` for `--diff`. Save it unchanged to `<run>/diff.patch`.
   List changed files. Re-classify with those files, then run
   `node <root>/scripts/tree.js --run <run> --files <changed files> --diff <run>/diff.patch --base <base>`
   (`--base HEAD` for `--diff`; leave `--base` out for a PR). This review-time
   tree.json replaces the one from classification. Record the wall-clock start
   time: `date -u +%s`.
3. Select providers for `review`.
4. Size S: run the one selected provider inline and write its records. For
   any CRITICAL or HIGH, write `select-providers.js review M --host cursor`
   output to `<run>/tmp/providers-M.json` and run
   `node <root>/scripts/pick-verifier.js <run> --providers <run>/tmp/providers-M.json`;
   dispatch the verifier it names, a provider of a different author.
5. Size M or L, in this order:
   1. Find: one read-only finder subagent per selected review provider, all
      in parallel, each given the diff, the changed files and the provider's
      strengths. When tree.json exists, add this line to every finder prompt:
      `Change tier: <tier>. Trunk files (read these hardest): <paths>.` Write each finder's records with `write-record.js`.
   2. Verify: save the provider list to `<run>/tmp/providers.json` and run
      `node <root>/scripts/pick-verifier.js <run> --providers <run>/tmp/providers.json`.
      For each CRITICAL or HIGH it names a verifier whose author differs from
      every author that raised the finding, or `null` with the note
      `no independent author available`. Start one read-only verifier
      subagent per finding that has a verifier, all in parallel, asking it to
      try to refute the finding and to default to refuted when it cannot
      confirm it. Write each verifier's record with
      `--verifies <R-id> --provider <verifier id> --author <verifier author> --verified true|false`.
      For a finding with no independent author, write a record from yourself
      with `--provider spine:orchestrator --author spine --verifies <R-id> --verified false --verifier-note "no independent author available"`;
      it is never counted as verified.
   3. Dissent: run `node <root>/scripts/da-gate.js <run> --devils-advocate <class.devils_advocate>`.
      Only when it prints `"open": true`, start the `devils-advocate`
      subagent with the verified findings and write its records (each
      carries `dissent` and `resolution`).
   4. Run `node <root>/scripts/check-cross-author.js <run>`. It exits
      non-zero when a verifier shares an author with a finding it verified;
      fix that before writing `review.json`.
6. Run [live verification](#live-verification) when the code under review is
   the working tree: a branch that is checked out, or `--diff`. A PR reviewed
   through `gh pr diff` is not on disk; write one `INFO` record instead, claim
   "live verification skipped: PR not checked out", evidence
   `command gh pr diff <n>`. Take `date -u +%s` before and after it and keep
   the difference as `live_verify_seconds` (0 when skipped).
7. Collect required proof. Skip this step when tree.json is absent.
   1. Run `node <root>/scripts/check-proof.js --run <run>` (add
      `--no-checkout` for a PR reviewed through `gh pr diff`). It writes
      `<run>/proof.json` and lists `required`, `present`, `missing` (each
      with a `hint`) and `info`. For each `info` entry write one `INFO`
      record from `spine:orchestrator`, claim
      `live verification not required: <reason>`, evidence
      `command node <root>/scripts/check-proof.js --run <run>`.
   2. For each `missing` command requirement, let `record-proof.js` run the
      project's own command and write the record. It runs the command with a
      timeout of `tiers.proof_timeout_seconds` from config (default 600),
      saves the output as evidence (the `node <root>/scripts/save-evidence.js --run <run> --from <file> --name <name>` logic), writes the record with agent `"spine:proof"`, parses node:test `# pass` and
      `# fail` totals (otherwise it keeps the exit code only), takes the
      `revision` from tree.json and numbers the record itself:
      `node <root>/scripts/record-proof.js --run <run> --kind <kind> --command "<cmd>" [--scope a,b]`.
      Use `--kind test_run` for the test suite, `--kind lint` or
      `--kind typecheck` for the static check when the repo has one,
      `--kind integration` or `--kind runtime_log` for integration or runtime
      proof, and `--kind migration_dry_run --target <non-production target>`
      for a dry-run. `--from <file>` records output you already captured
      instead of running the command (add `--exit-code N` when the output has
      no TAP totals). A failing command is still recorded and exits 1. Spine
      never runs deploys or rollbacks, never runs a migration against
      production and never connects to a production database. Never write
      `revision` or `result` by hand; a hand-written record without the exact
      tree.json revision is rejected as stale.
   3. Change tier trunk: write a short markdown file with a `## Rollback`
      section naming a revert command, a flag name, or the words "not
      instantly reversible" (a one-way door also needs backup or restore
      steps), then run
      `node <root>/scripts/record-proof.js --run <run> --kind rollback_plan --from <file.md>`.
      A `## Rollback` section in `review.md` still counts. Use
      `--kind flag_plan` for a flag. The human confirms it at G3 under
      "Confirm at G3" in the reading map.
   4. Change tier trunk: run
      `node <root>/scripts/record-proof.js --run <run> --kind test_quality`,
      which runs `node <root>/scripts/test-quality.js --run <run>` and writes its records.
      Its MEDIUM flags are advisories; they never make the verdict UNPROVEN.
   5. Run check-proof.js again. Whatever is still `missing` is a proof gap.
8. Record the wall-clock end time the same way (`date -u +%s`) and compute
   `elapsed_seconds` (end minus start, so it includes `live_verify_seconds`).
   This is total review-stage time, not
   a per-phase breakdown: only the orchestrating turn's own wall-clock is
   available. Write `review.json`: `{ "id", "upstream_id", "verdict",
   "providers": [ids], "findings": [ { "record_id", "severity",
   "corroboration", "verified" } ], "dissent": [record ids],
   "elapsed_seconds", "live_verify_seconds" }`. Then run `node <root>/scripts/verdict.js --run <run> --write` (add
   `--no-checkout` for a PR not checked out). It sets `verdict`, `tier` and
   `missing_proof` in review.json; never write `verdict`, `tier` or
   `missing_proof` by hand. Verdict is `FAIL` when any verified CRITICAL or HIGH
   remains, `UNPROVEN` when required proof is missing, `PASS_WITH_ADVISORIES`
   when only MEDIUM or lower remain, `PASS` when none. When the review loop
   fixes a finding, close it with a record from `spine:orchestrator` that has
   `"resolves": "<R-id>"` and the test or command that shows the fix as
   evidence, then re-run tree.js, check-proof.js and verdict.js. Mention the elapsed time in the STATE line, for example
   `review took 3m12s`.
9. Dispatch `spine:synthesis` for the stage. Write its record. Add its dissent
   map as a Mermaid diagram under a `## Dissent map` heading in `review.md`
   (optional companion file, not gated).
10. Run `node <root>/scripts/reading-map.js --run <run>`. It writes
    `<run>/reading-map.md` and prints `{ counts, minutes, g3, stale }`. If
    `stale` is true, re-run tree.js and this step.
11. Boundary checker `code-vs-plan` if a plan exists; for a standalone review
    with no plan, write one record from yourself with agent
    `spine:boundary-checker`, stage `review`, claim `PASS`, note "standalone
    review, no upstream". Gate G3: `awaiting: "G3"`, summary block with the
    reading map's `g3` string in STATE, for example
    `STATE: stage 5/5 review · run <id> · tier trunk · verdict UNPROVEN · read yourself 4 hunks, 12 min (whole diff 40 min) · .spine/<id>/reading-map.md`.
    When the verdict is UNPROVEN, DONE lists every proof gap as
    `<requirement> · <files> · <hint>`; for a PR not checked out the hint is
    "check out the branch to collect proof". Ask the human to confirm the
    rollback or flag plan listed under "Confirm at G3". Stop. On approval of an
    UNPROVEN review, write a waiver record from `spine:orchestrator`: claim
    `G3 waiver: UNPROVEN accepted`, evidence
    `{ "kind": "doc", "ref": "human message", "note": "<their words, max 200 chars>" }`,
    confidence 1, severity `INFO`, `"waives": [<requirement ids>]`. With
    `"unproven_blocks": true` in config (off by default: shadow mode),
    approve an UNPROVEN review only when the human explicitly waives every
    gap; with it off, approval proceeds and the waiver records it. Then
    stage `done`, status `done`, delete `active.json`.

### Opening a PR (after G3)

Only after G3 is approved (stage `done`), and only when the human asks for a
PR:

1. Read the change tier from `<run>/tree.json` (`branch` when it is absent).
   Write `<run>/pr-written.md` with the written sections: `## TL;DR` (at most
   3 lines for leaf, 5 otherwise) for every tier; for branch and trunk also
   `## The problem, with an example` with a before and an after; for trunk
   also `## The design decision that shaped everything`, drawn from the spec's
   owner decisions and the disagreements the owner resolved.
2. Run `node <root>/scripts/pr-body.js --run <run>`. It checks the written
   sections exist and fit the per-tier line caps, generates every other
   section from the run's records (what changed, rollout, decisions to check,
   how it was checked, not verified, how to test, and the risk and reading map
   for trunk), and writes `<run>/pr-body.md`. Fix every error it prints and
   run it again.
3. Ask the human before opening the PR, then run
   `gh pr create --title "<conventional commit title>" --body-file <run>/pr-body.md`.
   The title and body carry no attribution or co-author lines.

### Live verification

Tests prove the code; this proves the running app. It uses the repo's own
project-local `verify` skill, the kind `/pstack:create-verification-skill`
generates (a `.claude/skills/verify/SKILL.md` with launch, doctor, drive,
evidence, and cleanup sections plus a `features/` map). Spine never writes or
repairs that skill.

1. From the repo root run
   `node <root>/scripts/find-verify.js --files <comma-separated changed files>`.
   It prints `{ found, skills: [ { skillDir, skillFile, covers, features } ] }`,
   pairing each changed file with its nearest verify skill.
2. `found` false: write one `INFO` record, claim "no project verify skill
   covers the changed files", evidence `command` with the exact
   `node <root>/scripts/find-verify.js --files <...>` line you ran, resolution
   `{ "kind": "question", "text": "Create one with /pstack:create-verification-skill?" }`.
   Never generate one yourself; it needs the app running and the human's setup.
3. For each skill: read its `SKILL.md` and `features/README.md`. Pick the
   features whose entry points the covered files touch. If none clearly
   matches, run the skill's doctor and drive one mapped feature as a smoke
   check, and say "smoke check, no feature matched" in the claim. Follow
   the skill's own Launch, Doctor, Drive, Evidence, and Cleanup sections; its
   rules win over anything here, including what it says about processes it
   must not kill.
4. Write one record per feature driven, agent `spine:live-verify`, provider
   `project:verify`, `stage` set to the stage running it (`implement` or
   `review`). Evidence: the skill's evidence files as `file` entries and
   its doctor command as `command`. A feature that works is `INFO`. A feature
   that is broken by this change is `HIGH` or `CRITICAL` (real evidence
   exists, so the unverified-evidence cap does not apply). A feature the skill
   marks unreachable, or one you could not reach, is `MEDIUM` with the missing
   prerequisite in the evidence entry's `note`; never report it as verified.
   Also add `"revision"` (from tree.js) and `"payloads"` (each evidence file saved with `save-evidence.js`) so the record counts as `live_verify` proof.
5. Always run the skill's cleanup, even after a failure, and confirm its
   evidence survived before writing the records.

## Entry points

Invoked as `/spine <entry> ...`, for example
`/spine review <pr|branch|--diff>`. Parse the first word of the
arguments.

- `intent "<text>"`: start at `intent` with the text as the problem statement.
- `adopt <path|issue#>`: bootstrap writes `state.json` with `stage: "intent"`
  provisionally (bootstrap runs before you have read the file, so it cannot
  yet know the real stage). Then read the file (or
  `gh issue view <n> --json title,body`). Decide which stage it is: acceptance
  criteria only → `intent`; requirements and design → `spec`; tasks or
  tickets → `plan`. Correct `state.json`'s `stage` to that decision, normalize
  the content into that artifact with the required headings, run `gap-check`,
  run the boundary checker against the upstream artifact you had to synthesize
  (write that upstream artifact too, marked `status: adopted`), then continue
  at that stage's gate.
- `implement <id|ticket>`: load the run, require stage `implement` or an
  approved plan, continue at `implement`. A bare ticket id limits the run to
  that ticket. Never bootstrap here; if `active.json` is missing, stop and
  ask for `adopt` or `intent`, or `resume <id>` if a run already exists.
- `review <pr|branch|--diff>`: create a run whose intent is "review <target>",
  stage `review`, no upstream artifacts. Spec axis providers get the linked
  issue body if the PR or branch names one; otherwise standards axis only.
- `status`: read `state.json`, `class.json`, `tickets.json`, the latest
  records, and the output of `node <root>/scripts/run-status.js <run>`;
  render the summary block with the last host and the hooks that fired in
  STATE, and say so when `cap_reached` is true; set `awaiting: "human"`
  since the turn ends without progressing the stage; do nothing else.
- `resume <id>`: set `active.json` to the id, read `state.json`, continue at
  its stage. If `awaiting` is a gate (`G1`, `G2`, `G3`), re-ask that gate's
  question. If `awaiting` is `human`, clear it and continue the stage.

## Summary block

End every stage, every gate question, and every `status` with exactly this
block, one line per label except DONE and WHY which may be numbered lists:

```
NEXT: <one action the human can do in under two minutes>
STATE: stage <n>/5 <name> · run <id> · <progress, for example 2 of 4 tickets done>
DONE: <what this turn produced>
WHY: <one line per decision, each citing a record id>
DEBATED: <alternative> vs <chosen>, resolution: <test | spike | question>
DISSENT: <devil's advocate claim and record id, or "none, gate not triggered">
```

If the caveman skill is active, write the block in caveman style. Artifacts
on disk are always normal prose.

This block is the i-have-adhd shape by construction: next action first,
numbered work, state restated every time, one next action at the end. Do not
add prose before NEXT.

## Rules

- Bootstrap before analysis on `intent`, `adopt`, and `review`; load without
  creating on `implement` and `status`; on `resume` only point `active.json`
  at an existing run's `state.json`, never create one. No classification,
  provider selection, or agent dispatch happens until `state.json` and
  `active.json` exist for this run.
- Never fan out across a gate. Fan-out runs between gates only.
- Never verify a finding with the provider that raised it.
- Never write a record without evidence. `unverified` is allowed, but caps
  severity at MEDIUM.
- Never offer to skip a stage or a review. Size S is the minimum ceremony; a
  trivial diff still gets one provider, one record, and `review.json`. If the
  diff is empty, say so, write `review.json` with verdict `PASS` and zero
  findings, and proceed to G3.
- Never set `awaiting` to a gate name (`G1`, `G2`, `G3`) unless you are
  asking that gate's question in the same turn. Set it to `human` for any
  other turn that ends on a question to the human or on `status`, and clear
  it on the next turn.
- When a provider is not available in Cursor (the sessionStart context names its plugin as missing), dispatch a generic subagent with the provider's strengths pasted into the prompt, and say so in WHY: `<provider id> unavailable in Cursor, generic subagent with its strengths`.
- Never write `verdict`, `tier` or `missing_proof` by hand; `verdict.js --write`
  owns them. Use the fixed words file tier, change tier, signal, one-way door,
  gated, required proof, proof gap and reading map (read-yourself, skim, skip).
- One question to the human per turn.
- A gate passes only when the human approves in chat. A hook followup never
  answers a gate: never set `awaiting` to `null` for `G1`, `G2` or `G3`, and
  never move `stage` past a gate, because a hook asked you to continue.
- If the sessionStart context or `run-status.js` reports Stop cap-reached,
  say in STATE that the stage ended without being gate-clean, and finish the
  stage artifact and the boundary check before asking the gate question.
