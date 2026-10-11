---
name: record-contract
description: The output contract every Spine agent follows. A record is a claim with evidence references, a confidence, a severity, optional dissent, and an optional resolution. Load this when writing or reviewing any Spine provider prompt, and include its rules in every prompt sent to a reviewer, planner, or verifier.
---

# Record contract

Every agent working inside a Spine run returns its result as one or more
records. A record is a JSON object. The human never reads records directly;
the synthesis agent renders them.

## Shape

```json
{
  "id": "R-0007",
  "stage": "review",
  "agent": "ecc:security-reviewer",
  "provider": "ecc:code-review",
  "claim": "The upload handler accepts arbitrary paths.",
  "evidence": [
    { "kind": "file", "ref": "services/api/upload.py:42-58" },
    { "kind": "test", "ref": "pytest tests/test_upload.py::test_traversal", "result": "fail" }
  ],
  "confidence": 0.85,
  "severity": "HIGH",
  "dissent": null,
  "resolution": null,
  "alternatives": ["Sanitize with os.path.realpath", "Reject anything containing .."]
}
```

## Rules

1. `claim` is one sentence, falsifiable. Not "consider improving error
   handling" but "`create()` swallows `ValueError` at line 88 and returns
   200".
2. `evidence` has at least one entry. `kind` is `file`, `test`, `command`,
   `doc`, or `unverified`. `ref` is `path:line` or `path:start-end` for files,
   the exact command for commands and tests, a heading or line for docs.
3. A record whose evidence is only `unverified` may not be `HIGH` or
   `CRITICAL`. If you believe it is serious, go verify it, then raise it.
4. `confidence` is 0 to 1 and means "probability the claim is true as stated",
   not "how much I care".
5. `severity` is `CRITICAL` (data loss, security, outage), `HIGH` (bug or
   spec violation), `MEDIUM` (maintainability), `LOW` (style), `INFO`.
6. `dissent` is set only by the devil's advocate or by a verifier that
   refutes. It is the strongest case against the claim, with evidence.
7. `resolution` is set when reading the repo cannot settle a disagreement:
   `{ "kind": "test" | "spike" | "question", "text": "..." }`.
8. `alternatives` lists other approaches considered, so the human learns what
   was debated.
9. Records are written to `<run>/records/R-NNNN.json` by the spine skill.
   Agents that return text end with one fenced block tagged
   `json spine-record` per record. Agents called through a workflow return
   structured output and never write files.
