# spine

> **Status: alpha (0.1.0).** Commands, artifact shapes and gate behaviour may
> change between minor versions. `master` is the alpha channel; pin `v0.1.0`
> for a fixed version.

A gated, evidence-first engineering process for Claude Code. One plugin that
decides which of your installed process skills run for a task, forces artifact
boundaries between stages, cross-reviews with providers from different
authors, and renders a fixed six-line summary so you can follow along.

Claude Code only. Requires Node 22 or newer on `PATH`.

## Install

```bash
claude plugin marketplace add rassim-medkour/spine
claude plugin install spine@spine
```

Update with `claude plugin marketplace update spine`. Pin a version with
`claude plugin marketplace add https://github.com/rassim-medkour/spine.git#v0.1.0`. Remove with
`claude plugin uninstall spine@spine` and
`claude plugin marketplace remove spine`.

## Companion plugins

spine routes work to other plugins. Install the ones you want; any that are
missing are reported at session start (`spine: missing plugins: ...`) and
skipped. When a provider is missing, spine picks the next-ranked provider
from a different author; when a stage has no provider left, spine drafts
that stage inline. spine runs with none of them installed, with less
cross-review.

<!-- deps:required:start -->
| Plugin | Install | Used for | Without it |
|---|---|---|---|
| `ecc` | `claude plugin marketplace add affaan-m/ECC` then `claude plugin install ecc@ecc` | spec, plan, implement, review providers | top-ranked provider at every stage is skipped |
| `superpowers` | `claude plugin install superpowers@claude-plugins-official` | spec brainstorming, plan writing, subagent implement, code review | plan stage falls back to ecc planners or inline |
| `mattpocock-skills` | `claude plugin install mattpocock-skills@claude-plugins-official` | spec grilling, domain modeling, TDD, standards/spec review | second-author spec and review provider is lost |
| `code-review` | `claude plugin install code-review@claude-plugins-official` | low-noise review provider | one fewer review provider |
| `feature-dev` | `claude plugin install feature-dev@claude-plugins-official` | bug and logic review agent | one fewer review provider |
| `caveman` | `claude plugin marketplace add JuliusBrussee/caveman` then `claude plugin install caveman@caveman` | terse severity-tagged review agent | lowest-ranked review provider is lost |
<!-- deps:required:end -->

Optional (not checked at session start):

<!-- deps:optional:start -->
| Plugin | Install | Why |
|---|---|---|
| `i-have-adhd` | `claude plugin marketplace add ayghri/i-have-adhd` then `claude plugin install i-have-adhd@i-have-adhd` | the summary block follows its shape; spine works without it |
<!-- deps:optional:end -->

Rows with only an `install` command come from `claude-plugins-official`, the
marketplace Claude Code ships with, so they need no `marketplace add`.
Every `<plugin>@<marketplace>` key above matches a working install on the
maintainer's machine, and each `marketplace add` source matches that
machine's marketplace configuration. The rows have not been re-run on a clean
machine for this alpha; if one fails, please report it (see Reporting issues).

## What this plugin runs

Four hooks, all local Node scripts. They make no network calls.

| Hook | Script | Purpose |
|---|---|---|
| `SessionStart` | `scripts/session-start.js` | reports missing companion plugins |
| `Stop` | `scripts/stop-gate.js` | blocks the turn until the stage boundary check passes |
| `SubagentStop` | `scripts/subagent-gate.js` | same check for subagents |
| `PostToolUse` | `scripts/validate-artifact.js` | validates artifacts after Edit, Write and MultiEdit |

State is written to `.spine/` in your repo (runs, artifacts, `hooks.log`) and
read from `~/.spine/config.json` and `<repo>/.spine/config.json`.

Node 22 or newer must be on `PATH`. Without it the hooks fail with exit code
127 (command not found); this is noisy but does not block your session.

If a hook script itself errors (an internal exception), it exits 0 and prints
a `spine:` message to stderr; the gates let the stop through rather than
trapping you.

Escape hatch: set `"strictness": "warn"` in `~/.spine/config.json` or
`<repo>/.spine/config.json` and the gates warn instead of blocking. To close a
run, set `status` to `"paused"` in `.spine/<run-id>/state.json`; the Stop hook
only gates runs whose status is `active`.

## Workflow tool

Size L specs, and implement and review at sizes M and L, use Claude Code's
Workflow tool. You can tell it is unavailable when the tool is not in the
tool list, or a call to it is refused or errors before any agent runs. spine
then does not stop: it runs that stage on the size S inline path (one provider
inline, findings verified by a different author), writes an INFO record with
the claim `workflow tool unavailable, ran inline`, and keeps the gate chain.

## Entry points

```
/spine:spine intent "<what you want>"
/spine:spine adopt <spec.md | tickets.json | issue#>
/spine:spine implement <run-id | T-3>
/spine:spine review <pr# | branch | --diff>
/spine:spine status
/spine:spine resume <run-id>
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
- Live verification: at implement, and at review of a checked-out branch or
  `--diff`, spine looks for the repo's own `.claude/skills/verify/` skill
  nearest the changed files (`scripts/find-verify.js`), runs it to drive the
  touched features in the real app, and records the evidence. No verify skill
  means one `INFO` record suggesting `/pstack:create-verification-skill`;
  spine never generates or edits that skill. PR reviews via `gh pr diff` skip
  it, since the code is not on disk.

## Configuration

`~/.spine/config.json` (global) and `<repo>/.spine/config.json` (repo):

```json
{
  "strictness": "block",
  "lens_budget": 6,
  "second_model": false,
  "render_artifacts": false,
  "critical_paths": ["src/payments/**"]
}
```

- `artifacts_dir` can only be set in the global `~/.spine/config.json`, not in
  the repo config, because the repo config file lives inside that directory.
- `lens_budget` caps both the provider count per stage (`select-providers.js`)
  and the lens fan-out `scripts/classify.js` writes to `class.lenses` (up to
  9 lenses are possible before the cap — `correctness` and `security` are
  never dropped, since they are always inserted first).
- `critical_paths` globs use forward slashes only; Windows-style backslash
  paths never match.
- `npm test` is `node --test "tests/**/*.test.js"` (not `node --test tests/`)
  because a bare directory argument fails on Node 22 on Windows.

## Known limits

The skill writes the state the hooks read, so several things are trust
points rather than enforced guarantees in this release: setting `status: "paused"`
on a run, a repo config with `strictness: "warn"`, and the self-written
`spine:boundary-checker` PASS records for stages with no upstream artifact
(for example `intent`). Nothing stops the skill from writing any of these
without the condition they claim to be true actually holding. `hooks.log`
records every hook decision so these trust points are at least auditable
after the fact.

## Reporting issues

Open an issue at https://github.com/rassim-medkour/spine/issues. Please attach:

- spine version (`0.1.0`), Claude Code version, OS and `node --version`
- the command you ran and the size (S, M or L) of the run
- `.spine/<run-id>/hooks.log` and the failing artifact, with secrets removed
- any `spine:` lines from stderr or session start

## Contributing

Load a local clone for one session, or register it permanently:

```bash
claude --plugin-dir .
claude plugin marketplace add .
claude plugin install spine@spine
```

Run `claude plugin marketplace update spine` after pulling changes so the
installed copy picks them up. Run the tests with `npm test`. Release notes are
in [CHANGELOG.md](CHANGELOG.md).

### Headless runs

```bash
MSYS_NO_PATHCONV=1 CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p --plugin-dir . --permission-mode acceptEdits --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Skill,Agent,Workflow" --output-format text "/spine:spine review 1"
```

Safety: `acceptEdits` auto-approves file edits, and allowing `Bash` lets the
model run any shell command without a prompt. Together they give an unattended
run write access to the working tree and arbitrary command execution. Run this
only in a repository and environment you trust.

`MSYS_NO_PATHCONV=1` is needed because Git Bash (MSYS) rewrites an argument
starting with `/spine` into a filesystem path (for example
`C:/Program Files/Git/spine ...`) before Claude ever sees it. M and L runs
launch background workflows that outlive the 600 second default ceiling of
headless mode, so `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` is required or the
workflow is terminated and the run stops at `awaiting: human`. Check
`.spine/<id>/hooks.log` afterwards to confirm the hooks actually fired.

L-path reviews are slow (around 30 minutes headlessly on a 60-file diff,
root-caused to nested-skill fan-out per provider plus serialized
cross-verification plus the devil's advocate). `review.json` records total
`elapsed_seconds` for the review stage so this is at least visible; workflow
scripts cannot read the wall clock themselves (it would break resume), so this
is one number for the whole stage, not a per-phase breakdown.
