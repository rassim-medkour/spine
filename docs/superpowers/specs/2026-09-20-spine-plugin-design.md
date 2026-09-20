# Spine: a gated, evidence-first engineering process plugin for Claude Code

**Status:** design approved in conversation, pending written review
**Date:** 2026-09-20
**Owner:** Rassim (personal tooling, not project-specific)

## 1. Purpose

Spine is a Claude Code plugin that turns the loose collection of process skills
already installed (ECC, superpowers, mattpocock-skills, caveman, i-have-adhd,
oh-my-mermaid) into one operating model for three jobs:

1. Requirements and feature requests into specs and tickets.
2. Tickets into implementation with tests.
3. Code review, of other people's work and of my own.

The three jobs are interrelated. A weak spec drifts into a weak plan, which
drifts into wrong code, which a review then judges against the wrong target.
Spine's core job is therefore not "better agents per stage" but **hard
boundaries between stages**: every stage produces an artifact with a schema,
the next stage starts from that artifact only, and a checker compares stage N
against stage N-1 before N+1 may begin.

The design borrows five mechanisms from the ARGUS concept (a dropped
geopolitical-analysis project) and drops everything domain-specific:

| ARGUS mechanism | Spine equivalent |
|---|---|
| Multiple analytical schools reading one graph | Multiple review lenses reading one diff or spec |
| Confidence-gated devil's advocate (10th man) | Adversarial reviewer that fires only when reviewers agree and blast radius is high |
| Evidence chain from conclusion to source | Every finding cites `file:line`, a test run, a doc line, or is marked unverified |
| Resolution criteria for disagreements | Every unresolved dissent becomes a ticket of kind spike, test, or question |
| Silence detection (expected signal absent) | Gap check for missing acceptance criteria, error paths, rollback, tests, migrations |

Not borrowed: the temporal knowledge graph, graph neural networks, link
prediction. The codebase graph already exists through LSP and existing explorer
agents.

## 2. Non-goals (ring 1)

- Not a team tool. Personal, installed globally, works in any repo.
- No new language reviewers, security reviewers, or TDD agents. Reuse installed ones.
- No dashboard, no database, no server.
- No SDK-level orchestrator. The native Workflow tool is enough.
- No automatic modification of external trackers (Jira, GitHub issues). Read only in ring 1.

## 3. Principles

1. **If a script cannot check it, it is not a gate.** Gates are files with
   schemas and commands with exit codes. Prompts are advice, hooks are law.
2. **Agents write records, renderers write for the human.** Persisted
   artifacts are normal prose and structured JSON. Chat output is rendered from
   the record in the active style (caveman, ADHD shape).
3. **Fresh context per stage.** An implementer reads the spec cold. If the spec
   is ambiguous the implementer fails visibly instead of inheriting chat
   assumptions.
4. **Ceremony scales with the task.** A small task gets one reviewer and a
   stop hook. A critical-path task gets lenses, a council, a devil's advocate,
   and optionally a second model.
5. **Disagreement is output.** A dissent that cannot be resolved by reading is
   turned into work, not into a paragraph.
6. **Evidence diversity beats persona count.** One model playing eight roles is
   not eight sources. Independent evidence means a test that ran, a grep, a
   second model, or a human.

## 4. Plugin anatomy

```
spine/
  .claude-plugin/plugin.json
  commands/
    spine.md
  skills/
    spine/SKILL.md
    record-contract/SKILL.md
    gap-check/SKILL.md
  agents/
    boundary-checker.md
    devils-advocate.md
    synthesis.md
  workflows/
    spec.workflow.js
    implement.workflow.js
    review.workflow.js
  hooks/
    hooks.json
  scripts/
    classify.js
    validate-artifact.js
    stop-gate.js
    subagent-gate.js
    session-start.js
  providers.json
  schemas/
    class.schema.json
    intent.schema.json
    spec.schema.json
    tickets.schema.json
    plan.schema.json
    review.schema.json
    record.schema.json
  docs/
  tests/
  package.json
  README.md
```

### 4.1 plugin.json

Declares the plugin, its `userConfig`, and points at `hooks/hooks.json`.

`userConfig`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `strictness` | `warn` or `block` | `block` | Whether the stop gate blocks or only warns |
| `artifacts_dir` | string | `.spine` | Directory inside the target repo where run artifacts live |
| `lens_budget` | integer | 6 | Maximum parallel lens agents in a workflow |
| `second_model` | boolean | `false` | Allow `ecc:council-multi-model` on critical-path runs (still prompts for consent) |
| `render_artifacts` | boolean | `false` | Publish stage summaries as Artifact pages with diagrams |

Ring 1 hook scripts read `~/.spine/config.json` and `<repo>/.spine/config.json`
instead of `userConfig`, because hook scripts have no documented access to
plugin user config. The `userConfig` block documents intent only.

### 4.2 Dependencies

Spine is thin. It calls agents and skills from other plugins by their
namespaced names. `scripts/session-start.js` checks that each is installed and
prints one warning line per missing dependency.

| Dependency | Used for |
|---|---|
| `ecc` | `ecc:code-reviewer`, `ecc:<lang>-reviewer`, `ecc:security-reviewer`, `ecc:council`, `ecc:council-multi-model`, `ecc:intent-driven-development`, `ecc:tdd-guide`, `ecc:code-explorer`, `ecc:architect` |
| `superpowers` | `subagent-driven-development`, `writing-plans`, `test-driven-development`, `requesting-code-review` |
| `mattpocock-skills` | `code-review` (standards axis and spec axis), `grilling`, `domain-modeling`, `tdd` |
| `code-review` (Anthropic) | `code-review:code-review`, confidence-filtered PR review |
| `coderabbit` | `coderabbit:code-review`, external model, counts as independent source |
| `feature-dev` | `feature-dev:code-reviewer`, `feature-dev:code-explorer` |
| `caveman` | Chat rendering when active. Spine does not activate it. |
| `i-have-adhd` | Chat shape. Spine mirrors its rules because the skill forbids model invocation. |
| `oh-my-mermaid` | `omm-view` for browsing diagrams stored in `.omm/` |

## 5. Artifact chain

All artifacts for one run live in `<repo>/<artifacts_dir>/<id>/`. The `id` is
`YYYYMMDD-<slug>`. A run has a `state.json` that records the current stage
and is the only thing hooks need to read to know whether Spine is active.

| Artifact | Format | Produced by | Consumed by |
|---|---|---|---|
| `state.json` | JSON | spine skill | every hook |
| `class.json` | JSON | `scripts/classify.js` | spine skill, workflows |
| `intent.md` | Markdown with frontmatter | spine skill via `ecc:intent-driven-development` | spec stage |
| `spec.md` | Markdown with frontmatter | spec stage | plan stage, review spec axis |
| `tickets.json` | JSON | plan stage | implement stage |
| `plan.md` | Markdown with frontmatter | plan stage via `superpowers:writing-plans` | implement stage |
| `review.json` | JSON | review workflow | stop gate, PR body |
| `records/*.json` | JSON | every agent | synthesis, renderer |

Every artifact carries `upstream_id` in its frontmatter or JSON. `spec.md`
points at `intent.md`, `tickets.json` at `spec.md`, and so on. The boundary
checker walks this chain.

### 5.1 The record contract

Every agent output, whether from a workflow or a plain subagent, is a record:

```json
{
  "id": "R-0007",
  "stage": "review",
  "agent": "ecc:security-reviewer",
  "claim": "The upload handler accepts arbitrary paths.",
  "evidence": [
    { "kind": "file", "ref": "services/api/upload.py:42-58" },
    { "kind": "test", "ref": "pytest tests/test_upload.py::test_traversal", "result": "fail" }
  ],
  "confidence": 0.85,
  "severity": "HIGH",
  "dissent": null,
  "resolution": null,
  "alternatives": ["Sanitize with os.path.realpath", "Reject anything with .."]
}
```

Evidence `kind` is one of `file`, `test`, `command`, `doc`, `unverified`. A
record with only `unverified` evidence never reaches severity above `MEDIUM`.
`scripts/validate-artifact.js` enforces this.

### 5.2 Gap check

The gap check is the engineering form of silence detection. It runs on any
adopted or produced spec, plan, or ticket set and asks about absence, not
presence:

- Acceptance criteria present and testable?
- Error paths named?
- Data migration named, with rollback?
- Non-functional constraints named (auth, PII, performance)?
- Test anchors: does each acceptance criterion name at least one test?
- Out of scope section present?

Each gap becomes either a question to the human or an explicit assumption
written into the artifact under an `Assumptions` heading.

## 6. Classification

`scripts/classify.js` reads the intent or the diff and writes `class.json`:

```json
{
  "size": "M",
  "blast_radius": "critical",
  "signals": {
    "files": 9,
    "services": 2,
    "migration": true,
    "impact_matrix_hits": ["appointments", "communications"]
  },
  "lenses": ["correctness", "security", "python", "react"],
  "devils_advocate": true,
  "workflows": { "spec": true, "implement": true, "review": true }
}
```

Size heuristics (ring 1, tunable):

| Size | Files | Services | Migration |
|---|---|---|---|
| S | ≤ 3 | 1 | no |
| M | ≤ 12 | ≤ 2 | maybe |
| L | > 12 or new subsystem | > 2 | yes |

Blast radius:

- If the repo config lists `critical_paths` globs, touched paths are matched
  against them. Parsing `impact-matrix.yaml` is ring 2.
- Otherwise fallback to git churn of the touched paths over the last 90 days
  and the count of importers.

Devil's advocate gate (all three required, mirroring ARGUS):

1. Reviewers agree (no CRITICAL or HIGH dissent between lenses).
2. Size is L, or blast radius is critical.
3. At least two independent evidence kinds exist among the findings (for
   example `file` plus `test`), so the devil's advocate has something to
   contradict rather than prose.

## 7. Stages, gates, entry points

```
intent ─► classify ─► [spec] ─G1─► [tickets + plan] ─G2─► [implement] ─► [review] ─G3─► commit / PR
```

Human gates G1, G2, G3 live in the main conversation. Workflows run in the
background and cannot pause for approval, so no workflow ever spans a gate.

### 7.1 Stage behavior by size

| Size | Spec | Plan | Implement | Review |
|---|---|---|---|---|
| S | spine skill inline | inline | one implementer subagent | one reviewer subagent + boundary checker |
| M | two spec providers from different authors, gap check | `writing-plans` | `implement.workflow.js` | `review.workflow.js`, two providers |
| L or critical | `spec.workflow.js` lenses fan-out + `ecc:council` | `writing-plans` + `grilling` on the plan | `implement.workflow.js` | `review.workflow.js` with devil's advocate, optional second model |

### 7.2 Entry points

- `/spine:spine intent "<text>"`: full chain from scratch.
- `/spine:spine adopt <path|issue#|url>`: normalize an existing spec, ticket set, or
  plan into artifact shape, run the gap check, then continue from that stage.
- `/spine:spine implement <id|ticket>`: start at G2 with an adopted or produced plan.
- `/spine:spine review <pr|branch|--diff>`: standalone review. Standards axis always;
  spec axis only when a spec artifact or a linked issue exists. Devil's
  advocate gate still applies.
- `/spine:spine status`: render current state for the active run.
- `/spine:spine resume <id>`: reload state and continue at the recorded stage.

### 7.3 Boundary checker

Runs before every gate and inside the stop gate. Input: artifact N and
artifact N-1. Output: a record whose `claim` is `PASS` or a drift list. Each
drift item cites line references in both artifacts. It never proposes fixes; it
only reports drift. Fixes are the stage owner's job.

Checks per boundary:

| Boundary | Checks |
|---|---|
| spec vs intent | every acceptance criterion in intent appears in spec; nothing in spec contradicts intent constraints |
| plan vs spec | every spec requirement maps to at least one ticket; each ticket names its spec section |
| code vs plan | every ticket has a commit or diff hunk; no diff hunk lacks a ticket |
| tests vs acceptance criteria | each criterion has a named test that ran and passed |

### 7.4 Provider registry and cross review

Each stage has more than one capable provider already installed. Spine does
not pick a favorite. It keeps a registry, `providers.json`, that maps a stage
to the providers that can serve it, what each is good at, and who wrote it.
The classifier picks how many providers run; the registry decides which.

| Stage | Providers (ring 1) | Distinct strength |
|---|---|---|
| spec | `ecc:intent-driven-development`, `ecc:plan-prd`, `ecc:prp-prd`, `superpowers:brainstorming`, `mattpocock-skills:grilling`, `mattpocock-skills:domain-modeling` | acceptance criteria; PRD shape; adversarial questioning; ubiquitous language |
| plan | `superpowers:writing-plans`, `ecc:planner`, `ecc:prp-plan`, `ecc:code-architect`, `ecc:plan-canvas` | task granularity; codebase-pattern extraction; build order |
| implement | `superpowers:subagent-driven-development`, `ecc:prp-implement`, `ecc:tdd-guide`, `mattpocock-skills:tdd` | fresh-context per task; validation loops; test-first |
| review | `ecc:code-review` (multi-dimension, via `orch-review`), `mattpocock-skills:code-review` (standards axis and spec axis), `code-review:code-review` (Anthropic plugin, confidence-filtered), `coderabbit:code-review` (external service, different model), `feature-dev:code-reviewer`, `caveman:cavecrew-reviewer` | dimension fan-out; spec conformance; low-noise high-confidence; genuinely independent model; terse one-line findings |

Rules:

1. **Cross review, never self review.** When two or more review providers
   run, provider A's CRITICAL and HIGH findings are verified by provider B's
   verifier (or by Spine's own adversarial verifier), never by A. Same for the
   spec stage: the provider that drafted a section does not grade it.
2. **Evidence-keyed merge.** Findings from all providers are merged by
   normalized evidence snippet, as ECC's review workflow does. A finding that
   two authors' providers both raise gets a `corroboration` count of two.
   Corroboration feeds the devil's advocate gate.
3. **Author diversity counts as evidence diversity.** `coderabbit:code-review`
   uses a different model and counts as a second source for the gate, same as
   `ecc:council-multi-model`. Two ECC agents do not.
4. **Provider count scales with class.** S runs one provider. M runs two from
   different authors. L or critical runs three or more, capped by
   `lens_budget`.
5. **Registry is data, not code.** Adding, removing, or re-ranking a provider
   is an edit to `providers.json`. Ring 2 records which providers' findings
   survived verification and re-ranks from that.
6. **Ultra review is human-triggered.** `/code-review ultra` is billed and
   cannot be launched by Spine. The rendering block may suggest it at G3 for
   L or critical runs.

## 8. Agents (new in ring 1)

Only three. Everything else is reused.

- `boundary-checker`: read-only tools. Compares two artifacts, emits drift
  list. Model: default. Fresh context every call.
- `devils-advocate`: read-only plus test execution. Receives the consensus
  findings, builds the strongest case against them, searches for contradicting
  evidence, and names what evidence would settle it. Output is a record with
  `dissent` filled and `resolution` set to `spike`, `test`, or `question`.
- `synthesis`: receives all records for a stage. Produces consensus map,
  dissent list, blind-spot list (what each lens saw that others did not), and
  the human-facing summary block. Never adds findings of its own.

## 9. Workflows

Written against the Workflow tool script API (`agent()`, `parallel()`,
`pipeline()`, `phase()`, JSON `schema` per agent). Each script begins with
`export const meta = {...}` as a pure literal. Each keeps under ten agents per
run. Each reads `args` and throws on invalid input so a gate fails closed.

- `spec.workflow.js`: lenses fan out over `intent.md` (domain, architecture,
  data, security, ops, testability), then synthesis. Output: spec draft
  sections plus dissent list. Human edits and approves at G1.
- `implement.workflow.js`: per ticket, implementer subagent (TDD), then
  spec-compliance reviewer and quality reviewer in parallel, then merge. Mirrors
  `superpowers:subagent-driven-development`.
- `review.workflow.js`: one reviewer per lens and per selected provider in
  parallel, dedup findings by normalized evidence snippet, cross-verify every
  CRITICAL and HIGH with a verifier from a different provider, then devil's
  advocate if the gate passes. Modeled on ECC's `orch-review.workflow.js`.
  Providers that are skills rather than agents (for example
  `mattpocock-skills:code-review`) run as a `general-purpose` agent whose
  prompt invokes that skill; external providers (`coderabbit:code-review`)
  run through their own tool and their output is normalized into records.

The spine skill is what invokes them; skill instructions count as user opt-in
for the Workflow tool.

## 10. Hooks

`hooks/hooks.json` registers:

| Event | Matcher | Script | Behavior |
|---|---|---|---|
| `SessionStart` | any | `session-start.js` | check dependencies, print one warning line per missing one, exit 0 |
| `Stop` | any | `stop-gate.js` | if no active run in cwd, exit 0. Otherwise validate current stage artifact against schema and require the last boundary-checker record to be PASS. Exit 2 with a one-line reason in `block` mode, exit 0 with a warning in `warn` mode |
| `SubagentStop` | any | `subagent-gate.js` | if the subagent was launched by Spine (marker in its prompt), require its output to validate against `record.schema.json`. Ring 1 validates only when the payload carries `agent_transcript_path`; otherwise exit 0. |
| `PostToolUse` | `Edit` or `Write` on `<artifacts_dir>/**` | `validate-artifact.js` | revalidate the touched artifact, print errors, never block |

Safety rules for hooks:

- Every hook reads `state.json` first. No active run means immediate exit 0.
  Spine must never slow down or block sessions in repos where it is not in use.
- `stop-gate.js` honors `stop_hook_active` from the hook input to avoid an
  infinite block loop.
- Hooks are Node scripts with no dependencies outside the standard library.
  Schema validation in ring 1 is required-field and enum checking, not a full
  JSON Schema engine.

## 11. Rendering layer

Chat-facing output at the end of every stage has one fixed shape, which is the
i-have-adhd rule set baked in:

```
NEXT: <one action, under two minutes>
STATE: stage 3/5 implement · ticket T-12 · 2 of 4 tasks done
DONE: <numbered list of what changed>
WHY: <one line per decision, each citing a record id>
DEBATED: <alternative> vs <chosen>, resolution: <test | spike | ask product>
DISSENT: <devil's advocate claim, or "none, gate not triggered">
```

If caveman is active, the block is written in caveman style. Persisted
artifacts are always normal prose, because other humans and future agents read
them.

## 12. Diagrams

Mermaid inside artifacts, only where a picture beats text:

| Stage | Diagram |
|---|---|
| spec | component or context diagram, plus one sequence diagram for the main flow |
| plan | ticket dependency DAG with the critical path marked |
| review | dissent map: consensus, devil's advocate position, resolution items |

Writing `.omm/` files for `omm-view` is ring 2; ring 1 keeps Mermaid inside
artifacts. When `render_artifacts` is true, the stage summary is published as
an Artifact page using the `artifact-diagramming` guidance.

## 13. Installation and development

- Development: `claude --plugin-dir C:\Users\rassi\spine`.
- Later: a local marketplace entry so `claude plugin install spine@local`
  works from any repo.
- The plugin has its own git repo at `C:\Users\rassi\spine`.

## 14. Testing the plugin itself

- Unit tests with `node:test` for `classify.js`, `validate-artifact.js`,
  `stop-gate.js`, and `subagent-gate.js`, driven by fixture artifacts under
  `tests/fixtures/`.
- Hook contract tests: feed sample hook input JSON on stdin, assert exit code
  and stderr text.
- Integration dry run: run `/spine:spine review --diff` and `/spine:spine intent` on a
  small change in an existing repo, confirm hooks fire (logged to
  `<artifacts_dir>/<id>/hooks.log`), confirm the stop gate blocks when
  `review.json` is missing and releases when it is present.
- Workflow scripts are validated by a smoke run with `args` fixtures before
  being trusted.

## 15. Ring roadmap

**Ring 1 (this spec):** plugin skeleton, artifact chain and schemas,
classifier, three agents, three workflows, four hooks, rendering block, gap
check, four entry points, tests.

**Ring 2:** learn which lenses actually catch defects and prune the rest
(instinct data from ECC continuous learning); tune size thresholds from real
runs; `render_artifacts` pages; `claude plugin eval` suites.

**Ring 3:** write-back to trackers (create tickets from `tickets.json`,
post review summaries to PRs); optional team mode with a repo-committed
`.spine/config.json` and shared gates.

## 16. Risks and open questions

- **Hook cost in non-Spine sessions.** Mitigated by the state-file early exit,
  but the Node startup still costs tens of milliseconds per Stop. Measure.
- **Workflow tool availability.** The Workflow tool exists in this Claude Code
  build. If a future build removes or renames it, the M and L paths fall back
  to plain subagents run by the spine skill. The S path never depends on it.
- **Dependency drift.** ECC and superpowers rename agents between versions.
  `session-start.js` warns, and the spine skill treats a missing agent as
  "fall back to `general-purpose` with the lens prompt inline."
- **Same-model dissent.** The devil's advocate is the same model as the
  reviewers. The evidence-diversity gate limits, but does not remove, shared
  blind spots. `second_model` is the escape hatch.
- **Open:** should `adopt` accept Jira and GitHub issue URLs in ring 1, or
  only local files? Default: local files and GitHub issue numbers via `gh`;
  Jira in ring 3.
