# Cursor hook fixtures

Stdin payloads fed to `scripts/cursor/*.js` by the contract tests. Each file
states its provenance in a `_provenance` key: `docs-derived:<url>` means it
was written from cursor.com/docs and has not been recorded from a live
Cursor; `captured` means recorded in a real Cursor session and redacted
(paths replaced with `/workspace/...`, ids with `conv-captured-1`). Keys that
start with `_` are metadata and tests ignore them. Tests overwrite
`workspace_roots` with a temp repo. Never commit unredacted payloads, real
keys, or personal data.
