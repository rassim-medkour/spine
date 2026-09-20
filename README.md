# spine

A gated, evidence-first engineering process for Claude Code. One plugin that
decides which of your installed process skills run for a task, forces artifact
boundaries between stages, cross-reviews with providers from different
authors, and renders a fixed six-line summary so you can follow along.

## Install (development)

```bash
claude --plugin-dir C:\Users\rassi\spine
```

Requires Node 20 or newer on PATH. Dependencies (installed as Claude Code
plugins): `ecc`, `superpowers`, `mattpocock-skills`, `code-review`,
`coderabbit`, `feature-dev`, `caveman`, `i-have-adhd`. Missing ones are
reported at session start and skipped.

## Entry points

```
/spine intent "<what you want>"
/spine adopt <spec.md | tickets.json | issue#>
/spine implement <run-id | T-3>
/spine review <pr# | branch | --diff>
/spine status
/spine resume <run-id>
```

## How a run works

```
intent -> classify -> [spec] -G1-> [plan] -G2-> [implement] -> [review] -G3-> done
```

- Every stage writes an artifact under `.spine/<run-id>/` with a required
  shape (`schemas/`).
- A boundary checker compares each artifact to the one before it and must
  report PASS before you can move on. The Stop hook blocks the turn otherwise.
- Size S, M, or L (from `scripts/classify.js`) decides how many providers
  run: one, two, or three, always from different authors (`providers.json`).
- CRITICAL and HIGH findings are verified by a different author. The devil's
  advocate runs only when reviewers agree, the blast radius is high, and at
  least two kinds of evidence exist.
- Unresolved disagreements become tickets of kind spike, test, or question.

## Configuration

`~/.spine/config.json` (global) and `<repo>/.spine/config.json` (repo):

```json
{
  "strictness": "block",
  "lens_budget": 6,
  "second_model": false,
  "render_artifacts": false,
  "critical_paths": ["services/main/appointments/**"]
}
```

- `artifacts_dir` can only be set in the global `~/.spine/config.json`, not in
  the repo config, because the repo config file lives inside that directory.
- `critical_paths` globs use forward slashes only; Windows-style backslash
  paths never match.
- `npm test` is `node --test "tests/**/*.test.js"` (not `node --test tests/`)
  because a bare directory argument fails on Node 22 on Windows.

## Known limits (ring 1)

The skill writes the state the hooks read, so several things are trust
points rather than enforced guarantees in ring 1: setting `status: "paused"`
on a run, a repo config with `strictness: "warn"`, and the self-written
`spine:boundary-checker` PASS records for stages with no upstream artifact
(for example `intent`). Nothing stops the skill from writing any of these
without the condition they claim to be true actually holding. `hooks.log`
records every hook decision so these trust points are at least auditable
after the fact.

## Tests

```bash
npm test
```
