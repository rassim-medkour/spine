# Cursor smoke test (manual, pending)

Status: NOT YET RUN. Cursor support in 0.2.0 is built from Cursor's
documentation and has not been tested in a live Cursor agent session. Ticket
T-24 owns this checklist. CI cannot run Cursor, so a person with a Cursor
subscription runs it, once on Windows and once on macOS or Linux, before the
Cursor section of the README drops the word "experimental".

Use a throwaway git repository as the workspace. Record the Cursor version
and OS for each run.

## 1. Install

- [ ] In Cursor, open Customize > Marketplace and add
      `https://github.com/rassim-medkour/spine` (or load the clone as a
      local plugin).
- [ ] Reload the window. Confirm spine's four hooks (sessionStart, stop,
      subagentStop, postToolUse) are listed and show no errors in the Hooks
      output channel.
- [ ] If the Claude Code spine plugin is also imported, confirm each gate
      fires once (one line per event in `hooks.log`, not two).

## 2. Run an S-sized task through intent to done

- [ ] In Agent chat, ask for the Spine skill with the `intent` entry point on
      a small task. Confirm `.spine/<run-id>/state.json` appears with
      `host: "cursor"`.
- [ ] Stop the turn before `intent.md` exists. Confirm a stop followup names
      what is missing (at most 3 of them), and that no followup arrives while
      the run waits at G1, G2 or G3.
- [ ] Approve G1 in chat, continue through spec, plan and implement, and
      reach stage `done`. Confirm the summary block renders.
- [ ] Confirm `.spine/<run-id>/hooks.log` has entries for sessionStart, stop
      and postToolUse, and that every record under `records/` validates.

## 3. Cap behavior

- [ ] Leave a stage not gate-clean and let the stop hook re-prompt. After the
      third followup confirm the warning appears, a `Stop cap-reached` record
      is written, and `status` reports it.
- [ ] Start a new conversation on the same run and confirm its followup count
      starts at zero.
- [ ] Abort a turn from the UI and confirm no followup restarts the agent.

## 4. Headless

- [ ] Run `cursor-agent -p` (print mode) with a prompt that invokes the Spine
      skill. Record whether hooks fire, and what `cursor-agent` does when the
      stop hook returns a followup.

## 5. Cross-host and fan-out

- [ ] Resume the same run in Claude Code and confirm the host change warning.
- [ ] Run a review that fans out to parallel subagents. Confirm the
      cross-author check script reports independent authors, and note
      whether imported Claude skills resolve as providers under their plugin
      names (the naming is unverified).

## 6. Confirm unverified payload fields

- [ ] From the Hooks output channel, confirm the stop, subagentStop,
      postToolUse and sessionStart payloads match
      `tests/fixtures/cursor/*.json` (field names, `workspace_roots`,
      `transcript_path`, `loop_count`). Redact paths and the user email before
      updating any fixture.
- [ ] Confirm whether the stop hook's stderr warning is visible to the user.

## Evidence

Paste results below: Cursor version, OS, each step marked pass or fail, the
redacted `hooks.log`, and any fixture corrections. Link it from the T-24
ticket and update the CHANGELOG known limitations accordingly.
