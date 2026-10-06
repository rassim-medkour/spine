# Changelog

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
