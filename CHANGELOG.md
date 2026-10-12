# Changelog

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
