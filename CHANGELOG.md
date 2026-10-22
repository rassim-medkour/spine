# Changelog

## 0.3.2

Cursor support is still experimental and the live Cursor smoke test is pending.

### Fixed

- [claude-code] `/spine:spine-review`, `/spine:spine-spec` and `/spine:spine-implement` now start the full spine run (`review`, `intent` and `implement`). Before, these names ran the internal workflow with no input: it failed at once, and the review that followed had no run folder, risk tiers, proof, verdict or reading map.
- [claude-code] The three workflows are renamed `spine-internal-review`, `spine-internal-spec` and `spine-internal-implement`. Started with no input, each one stops with a message that names the command to use instead.
- [both] `review` with no target asks for one before it creates anything, and the run folder is named after the target (`20261022-pr-885`), not `target-pending`.
- [both] Proof for a PR or branch that is not checked out now runs in a temporary git worktree (`scripts/review-worktree.js`), which spine removes afterwards. Before, every proof requirement was a gap, so the verdict was always `UNPROVEN` and every hunk was marked read-yourself.
- [both] The reading map has a time budget (`tiers.read_budget_minutes`, default 20). The riskiest hunks fill read-yourself first; the rest are listed in the same order under "Read if you have time". One-way doors and open dissent are never moved out. A hunk cited by an open MEDIUM or higher finding is now read-yourself.

## 0.3.1

Cursor support is still experimental and the live Cursor smoke test is pending.

### Fixed

- [both] The "instant rollback?" review question now reads a recorded rollback or flag plan: `yes (R-NNNN: ...)`, or `no plan` on a trunk change without one. Before, it always said "unknown".
- [both] The test suite no longer leaves `spine*` temp folders behind. Older versions left dozens per run. To clean up existing ones on Windows, run `Remove-Item "$env:TEMP\spine*" -Recurse -Force`.

## 0.3.0

Cursor support is still experimental: it is built from Cursor's documentation
and the manual Cursor smoke test is pending (checklist in
`docs/cursor-smoke-test.md`).

### Added

- [both] File tiers (trunk, branch, leaf) from nine recorded signals, written by `scripts/tree.js` to `.spine/<run>/tree.json` with a documented, versioned shape.
- [both] Import parsers for Python, TypeScript, JavaScript and Go, plus a generic fallback for every other language; a per-blob import cache under `.spine/cache/`.
- [both] Required proof per change tier, checked by `scripts/check-proof.js`; evidence files saved and capped by `scripts/save-evidence.js`.
- [both] New verdict `UNPROVEN` when required proof is missing, computed by `scripts/verdict.js` (FAIL > UNPROVEN > PASS_WITH_ADVISORIES > PASS). Shadow mode in this release: G3 can approve and the approval is recorded as a waiver; set `"unproven_blocks": true` to block.
- [both] Advisory hollow-test check (`scripts/test-quality.js`) for Python, JS/TS and Go tests.
- [both] Reading map (`scripts/reading-map.js`): read-yourself, skim and skip with reasons and reading times, summarised in the G3 block.
- [both] PR description generator (`scripts/pr-body.js`) and `.github/pull_request_template.md`.
- [claude-code] The review workflow passes the change tier and trunk files to finders.
- [both] Model routing: `scripts/select-model.js` picks a model per role and change tier (Balanced table), writes `<run>/models.json`, and records stamp the requested model.
- [cursor] Read-only Cursor model discovery from local app state (experimental).
- [both] Model mix in the PR description and `run-status.js`.

### Changed

- [both] `review.json` may carry `tier` and `missing_proof`; `class.json` may carry `tier`. Every 0.2.0 file still validates.
- [both] Model routing is on by default (Balanced); this is a behaviour change. Set `"model_policy": "inherit"` to keep every agent on the session model.
- [claude-code] The three workflows accept `args.models`; without it every `agent()` call is unchanged (claude-baseline.json entries for the workflows regenerated).

### Turning it off

- [both] Set `"risk_tiers": false` in `~/.spine/config.json` or the repo config to get 0.2.0 behaviour back. Pin `v0.2.0` to stay on the previous version.
- [both] `"model_policy": "inherit"` turns model routing off.

### Fixed

- [both] Tests clean up the temporary directories they create.

### Known limitations

- [both] Fan-in is module-level; there is no call graph and no language server.
- [both] Reading times are estimates from fixed lines-per-minute rates.
- [both] An older spine install does not know the `UNPROVEN` verdict: its validator reports a review.json carrying it as a schema problem and asks for a fix, so it can hold up the review step until the file is edited by hand. Pin one version per repo.
- [both] tree.json is not always reproducible: when `tree_budget_ms` is exceeded the tree is partial (unknown fan-in, never leaf), so a re-run on the same revision can produce a different tree.json.
- [both] Seven baseline-pinned test files still leak temporary directories.
- [cursor] Whether Cursor's Task tool accepts a per-call model is unverified; spine passes a model only when the tool exposes the parameter.
- [claude-code] What the Workflow tool's `agent()` does with an unknown model id (throw, `null` or silent substitution) is unverified; spine retries once on the session model.
- [both] Records hold the requested model, not the model that ran; no Cursor hook reads the observed model in this release.

## 0.2.0

Cursor support is experimental: it is built from Cursor's documentation and
has not been tested in a live Cursor agent session.
The manual Cursor smoke test is pending (checklist in `docs/cursor-smoke-test.md`).
Hook behavior was cross-checked against the Cursor 3.23.12 app bundle (BOM on
Windows stdin, stop and subagentStop working directory) but is still not
tested in a live agent session.

### Added

- [cursor] Cursor plugin: `.cursor-plugin/` manifests, `hooks/cursor-hooks.json`
  (sessionStart, stop, subagentStop, postToolUse); every hook fails open.
- [cursor] Stop and subagentStop gates as followup messages, at most 3 per
  conversation and stage, then a visible warning and a `Stop cap-reached` record.
- [cursor] Cursor orchestration skill with prompt-driven subagent fan-out, and
  `write-record.js`, `pick-verifier.js`, `da-gate.js` and `check-cross-author.js`.
- [cursor] Cursor provider registry and `select-providers.js --host cursor`.
- [both] `state.json` records the last writer `host`; `run-status.js` reports
  hooks per host; spine warns when the host changes.

### Changed

- [both] Gate logic moved into `scripts/lib/gate.js` and `scripts/lib/session.js`;
  Claude hook outputs are byte-identical, pinned by a golden-output test.
- [claude-code] Hooks ignore empty, non-JSON or oversized (over 1 MB) stdin
  with one `spine:` line on stderr instead of evaluating the current directory.
- [claude-code] When Cursor is detected and the Cursor spine copy is installed,
  the Claude-format hooks do nothing, so each gate fires once.

### Known limitations

- [cursor] Gates are advisory and gate approval is honor-system; the stop gate
  re-prompts up to 3 times instead of blocking.
- [cursor] No Workflow-tool fan-out; naming of imported Claude skills is unverified.
- [cursor] Not yet verified in a live Cursor session (smoke test pending).
- [both] One host at a time per run is documented, not enforced.

## 0.1.1

### Fixed

- Installed copies could not run M and L stages: the skill called the Workflow
  tool with a `scriptPath` inside the plugin cache, which the tool refuses to
  read. Workflows are now called by their registered names
  (`spine:spine-spec`, `spine:spine-implement`, `spine:spine-review`).
- All three hooks fail open, and the third review provider is
  `superpowers:requesting-code-review` (CodeRabbit removed).

## 0.1.0

First public alpha release (Claude Code only). Installable through its own
marketplace: `claude plugin marketplace add rassim-medkour/spine`, then
`claude plugin install spine@spine`.

### Added

- MIT license and public manifest metadata.
- Dependency table in the README, tied to `providers.json` by a test.
- Workflow-tool fallback: M and L stages run on the size S inline path when
  the Workflow tool is unavailable.
- Release tests: license, manifests, scrub scans, README structure.

### Changed

- The Stop and SubagentStop gates fail open: an internal error exits 0 and
  prints a `spine:` message to stderr instead of blocking.

### Known limitations

- Alpha: commands, artifact shapes and gate behaviour may change.
- Claude Code only; Cursor is not supported.
- Requires Node 22 or newer on `PATH`; without it hooks exit 127.
- The skill writes the state the hooks read, so `status: "paused"`, a repo
  `strictness: "warn"` and self-written boundary PASS records are trust
  points, not enforced guarantees. `hooks.log` makes them auditable.
- L-path reviews are slow (around 30 minutes headlessly on a 60-file diff).
- Hook scripts make no network calls, but this was read, not fully audited.
- Companion plugin install commands were not all re-verified on a clean
  machine.
- Git history is not rewritten and still contains earlier author emails.
