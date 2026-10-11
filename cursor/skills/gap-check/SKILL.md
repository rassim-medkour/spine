---
name: gap-check
description: Silence detection for specs, plans, and ticket sets. Asks what is expected but absent, such as acceptance criteria, error paths, migrations with rollback, non-functional constraints, test anchors, and scope boundaries. Use on any adopted artifact and on every drafted spec before the human gate.
---

# Gap check

Reviewers check what is present. This skill checks what is missing. Run it on
`intent.md`, `spec.md`, `plan.md`, and `tickets.json`, whether Spine produced
them or `/spine:spine adopt` imported them.

## The six absence questions

Answer each with `present`, `absent`, or `partial`, with a line reference for
`present` and `partial`.

1. **Acceptance criteria.** Are they present, numbered, and testable? A
   criterion is testable when a reader can name the input, the action, and the
   observable result.
2. **Error paths.** For every action the artifact names, is the failure case
   named: invalid input, missing permission, dependency down, partial
   completion?
3. **Data and migration.** If any stored shape changes, is the migration
   named, and is the rollback named? If nothing changes, is that stated?
4. **Non-functional constraints.** Auth and permission model, PII handling,
   performance budget, observability. Absent means unstated, not "not
   applicable"; "not applicable" must be written down.
5. **Test anchors.** Does every acceptance criterion name at least one test
   that will prove it? For tickets, does every ticket name a test?
6. **Out of scope.** Is there an explicit list of what this work will not do?

## What to do with a gap

Each `absent` or `partial` becomes exactly one of:

- A question to the human, if the answer changes the design. Put it in the
  summary block under NEXT, one question per turn.
- An explicit assumption written into the artifact under `## Assumptions`,
  if a sensible default exists. Assumptions are reviewed at the next gate.

Never silently fill a gap. Never leave a gap unrecorded.

## Output

A table of the six questions with status and reference, the list of
questions and assumptions, then a record block with `agent` set to the agent
running this skill, `claim` `GAPS: <n>` or `GAPS: 0`, and one `doc` evidence
entry per gap.
