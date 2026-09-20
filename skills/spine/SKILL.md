---
name: spine
description: Orchestrates a gated, evidence-first engineering run. Classifies the task, routes it through intent, spec, plan, implement, and review with cross-provider agents, enforces artifact gates, and renders a fixed summary block. Entry points intent, adopt, implement, review, status, resume. Use when starting any non-trivial feature, ticket, or review.
---

# Spine

You are running the Spine process. Read this whole file before acting.

Plugin root: the directory two levels above this file. Scripts live in
`<root>/scripts/`, workflows in `<root>/workflows/`. Own agents are addressed
as `spine:boundary-checker`, `spine:devils-advocate`, `spine:synthesis`.

Load the `record-contract` skill once per session before dispatching any
agent. Load `gap-check` when the instructions below say so.

## State you own

All artifacts for a run live in `<repo>/.spine/<id>/` (or the configured
`artifacts_dir`). Run id is `YYYYMMDD-<slug>` where slug is 2 to 4 lowercase
words joined by dashes. You are the only writer of:

- `.spine/active.json`: `{ "id": "<id>" }`
- `<run>/state.json`: `{ "id", "stage", "status", "awaiting", "size", "updated" }`
  - `stage` is one of `intent`, `spec`, `plan`, `implement`, `review`, `done`.
  - `status` is `active`, `paused`, or `done`.
  - `awaiting` is `null`, `G1`, `G2`, or `G3`. Set it to the gate name in the
    same turn you ask the human for approval. Set it back to `null` in the
    turn after they approve. The Stop hook lets a turn end only when the
    stage artifact is valid and boundary-checked, or when `awaiting` is set.
    Never set `awaiting` to dodge a gate.
  - `updated` is an ISO 8601 timestamp; get it with `date -u +%Y-%m-%dT%H:%M:%SZ`.
- `<run>/class.json`: output of `node <root>/scripts/classify.js`.
- `<run>/records/R-NNNN.json`: one file per record. Get the next id by
  listing the directory; ids are zero-padded to four digits.
- Stage artifacts: `intent.md`, `spec.md`, `tickets.json`, `plan.md`,
  `review.json`. Their required headings and keys are in `<root>/schemas/`.
  The PostToolUse hook validates them on every write and tells you what is
  missing.

## Records

Every agent you dispatch returns findings. Agents run through the Agent tool
end with a fenced block tagged `json spine-record`; copy each block into
`records/R-NNNN.json`. Workflows return `{ records }`; write each entry to
`records/` after renumbering ids sequentially. A record with only
`unverified` evidence may not be HIGH or CRITICAL; downgrade or verify.

## Classification

Run once per run, and again at `review` if the diff changed the file set:

```bash
node <root>/scripts/classify.js --files <comma-separated changed or planned files> [--migration] [--new-subsystem]
```

Write the output to `<run>/class.json`. It decides:

| Field | Effect |
|---|---|
| `size` S | inline stages, one provider, no workflows |
| `size` M | two providers from different authors, `implement` and `review` workflows |
| `size` L | three providers, all three workflows, council on the spec |
| `blast_radius` critical | security lens on, devils advocate on |
| `devils_advocate` true | pass `devilsAdvocate: true` to the review workflow |

Select providers per stage with:

```bash
node <root>/scripts/select-providers.js <stage> <size>
```

Pass the printed list to workflows as `args.providers`, and use it to decide
which skills or agents to invoke inline for size S.

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
4. Classify. Write `class.json`. Dispatch the boundary checker is not needed
   for intent (no upstream); instead write one record from yourself with
   agent `spine:boundary-checker`, stage `intent`, claim `PASS`, evidence
   `doc intent.md:1`, note "no upstream". Move stage to `spec`.

### spec

- Size S or M: draft `spec.md` yourself with headings `## Summary`,
  `## Requirements`, `## Design`, `## Error paths`, `## Data and migrations`,
  `## Test anchors`, `## Assumptions`, `## Out of scope`. For M, invoke the two
  selected spec providers first and fold their output in.
- Size L: call the Workflow tool with
  `scriptPath: "<root>/workflows/spec.workflow.js"` and
  `args: { intentText, lenses: class.lenses, providers, runId }`. Write the
  merged sections into `spec.md` and each `dissent` entry under a
  `## Open disagreements` heading with its resolution. Then run `ecc:council`
  on the two most consequential disagreements.
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
- Size M or L: call the Workflow tool with
  `scriptPath: "<root>/workflows/implement.workflow.js"` and
  `args: { tickets, specText, planText, runId, providers, parallel: false }`.
  Write returned records. Mark each ticket `done` in `tickets.json` when
  `implemented` is true and both reviews pass; otherwise `blocked` with the
  blockers listed in the ticket.
- Boundary checker `code-vs-plan`, then `tests-vs-acceptance` with the test
  command from `plan.md`. Move stage to `review`.

### review

1. Compute the diff: `git diff <base>...HEAD` for a branch, `gh pr diff <n>`
   for a PR, `git diff` for `--diff`. List changed files. Re-classify with
   those files.
2. Select providers for `review`.
3. Size S: run the one selected provider inline (invoke its skill or agent),
   write its records, then dispatch a verifier of a different author for any
   CRITICAL or HIGH.
4. Size M or L: call the Workflow tool with
   `scriptPath: "<root>/workflows/review.workflow.js"` and
   `args: { diff, changedFiles, language, providers, devilsAdvocate: class.devils_advocate, runId, stage: "review" }`.
   Write the returned records.
5. Write `review.json`: `{ "id", "upstream_id", "verdict", "providers": [ids], "findings": [ { "record_id", "severity", "corroboration", "verified" } ], "dissent": [record ids] }`. Verdict is `FAIL` when any verified CRITICAL or HIGH remains, `PASS_WITH_ADVISORIES` when only MEDIUM or lower, `PASS` when none.
6. Dispatch `spine:synthesis` for the stage. Write its record. Add its dissent
   map as a Mermaid diagram under a `## Dissent map` heading in `review.md`
   (optional companion file, not gated).
7. Boundary checker `code-vs-plan` if a plan exists; for a standalone review
   with no plan, write one record from yourself with agent
   `spine:boundary-checker`, stage `review`, claim `PASS`, note "standalone
   review, no upstream". Gate G3: `awaiting: "G3"`, summary block, and for
   size L suggest `/code-review ultra` as an optional extra. Stop. On
   approval: stage `done`, status `done`, delete `active.json`.

## Entry points

Parse the first word of the arguments.

- `intent "<text>"`: start at `intent` with the text as the problem statement.
- `adopt <path|issue#>`: read the file (or `gh issue view <n> --json title,body`).
  Decide which stage it is: acceptance criteria only → `intent`; requirements
  and design → `spec`; tasks or tickets → `plan`. Create the run, normalize the
  content into that artifact with the required headings, run `gap-check`, run
  the boundary checker against the upstream artifact you had to synthesize
  (write that upstream artifact too, marked `status: adopted`), then continue
  at that stage's gate.
- `implement <id|ticket>`: load the run, require stage `implement` or an
  approved plan, continue at `implement`. A bare ticket id limits the run to
  that ticket.
- `review <pr|branch|--diff>`: create a run whose intent is "review <target>",
  stage `review`, no upstream artifacts. Spec axis providers get the linked
  issue body if the PR or branch names one; otherwise standards axis only.
- `status`: read `state.json`, `class.json`, `tickets.json`, the latest
  records; render the summary block; do nothing else.
- `resume <id>`: set `active.json` to the id, read `state.json`, continue at
  its stage. If `awaiting` is set, re-ask the gate question.

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

## Rules

- Never call a workflow across a gate. Workflows run between gates only.
- Never verify a finding with the provider that raised it.
- Never write a record without evidence. `unverified` is allowed, but caps
  severity at MEDIUM.
- Never set `awaiting` unless you are asking the human a gate question in
  the same turn.
- When a dependency plugin is missing (the SessionStart hook tells you), use
  `general-purpose` with the provider's strengths pasted into the prompt, and
  say so in WHY.
- One question to the human per turn.
