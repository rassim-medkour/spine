# Absent product context baseline (0.3.2)

Artifacts produced by spine 0.3.2 (commit `6979785`) for one fixed change with no `.spine/product.md`. Version 0.4.0 must produce byte-identical artifacts for the same change, apart from one `INFO` record (REQ-1, AC-12).

## How `0.3.2/` was captured

Run from the repository root, before any 0.4.0 code existed:

```bash
git worktree add /tmp/spine-0.3.2 6979785
node tests/fixtures/product/absent-baseline/capture.js --spine-root /tmp/spine-0.3.2 --out tests/fixtures/product/absent-baseline/0.3.2
git worktree remove /tmp/spine-0.3.2
```

`capture.js` copies `tests/fixtures/graph/typescript` into a fresh git repository, commits it with fixed author, committer and dates (so `head_sha` is `5bd80dc2952d108b566ada1b80e4e1ec2433f14d` on every machine), appends one line to `src/lib/math.ts` and `src/app.ts`, then runs the checkout's own CLIs exactly as the spine skill does:

1. `scripts/classify.js --files src/lib/math.ts,src/app.ts` into `classify.json`
2. `scripts/tree.js --run <run> --files ... --diff <run>/diff.patch --base HEAD` into `tree.json` and `diagnostics.json`
3. `scripts/reading-map.js --run <run>` into `reading-map.md` and `reading-map.json`
4. `scripts/pr-body.js --run <run>` into `pr-body.md` (state `done`, a `PASS` `review.json`, a three-section `pr-written.md` and a one-assumption `spec.md` are written first)

`manifest.json` records the head sha, the changed files, the artifact list, the `records/` directory listing, each CLI's JSON output, the `run-status.js` output (`run_status`) and the sorted run folder listing (`run_folder`). `models.json` is not part of the proof: REQ-18 changes the policy hash by design. The run folder may differ from the baseline only by `product.json` (REQ-2) and the one `INFO` record under `records/`.

## Comparing against a newer version

```bash
node tests/fixtures/product/absent-baseline/capture.js --spine-root . --out /tmp/absent-now
```

Every file in `0.3.2/` must be byte-equal to the new output except `diagnostics.json`, where `elapsed_ms` is wall-clock time and is stripped before comparison. Two captures from the same checkout agree on every other byte. `tests/product-absent.test.js` runs this comparison (T-14).

Never edit `0.3.2/` by hand. If a newer version differs, fix the code that drifted, not the baseline.
