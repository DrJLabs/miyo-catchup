# Public design evidence and limitations

This sanitized summary preserves design lessons from a private manual recovery.
It intentionally omits machine identity, personal paths, account/conversation IDs,
chat titles/content, database snapshots and private recovery artifacts.

## Observed lessons

- Browser-authenticated cursor catalog reads and batched full-conversation
  downloads worked without reconnecting native Miyo sync in a manual recovery.
- The catalog was not strictly ordered by update timestamp. A chronological
  cutoff or first-unchanged-page shortcut can omit changes.
- The tested Miyo 0.2.28 file-write endpoint and native watcher could dispatch
  concurrent indexing of the same file. Atomic publication with watcher-only
  indexing avoided that additional dispatcher in the manual route.
- Native integration involves Markdown, `chat_conversations` metadata and the
  dedicated chats index. File counts alone do not prove indexed freshness.
- A detached verification process stopped while Miyo continued indexing; the
  root cause was not established. Saved progress is not liveness evidence.
- Stock Miyo Capture 0.3.7's periodic sync path hands credentials to Desktop,
  rather than scheduling the separate manual ZIP-download flow. This project
  neither invokes nor modifies that sync path.

## What is not proved

The custom extension-to-local transport, complete crash recovery, current-build
adapter compatibility, every recovered file's exact vector freshness, and daily
operation still require the plan's qualification gates. Historical successful
requests are not a supported API guarantee or a promise of independent quota.

Initial runtime probes used Node 22.23.2, systemd 255 and Chrome 153. Node SQLite
basic in-memory transactions worked but remained experimental. Recheck the
actual installation and conduct crash/durability tests before claiming support.

## Evidence policy

Operators retain raw evidence in private state outside this repository. Public
tests use synthetic fixtures. Release summaries may cite sanitized outcomes and
software versions, never private chat payloads or credentials. Do not run old
recovery helpers blindly: their diagnostic commands can write private receipts.
