# Local runtime foundations

The [implementation plan](../docs/implementation-plan.md) is authoritative.
T01 provides reusable offline primitives. T02 adds native transport/entry,
an explicit private socket and a single-probe receiver; no working capture CLI,
full coordinator, importer or running service is included. Private pairing state
is recorded only in the canonical implementation checkpoint.

- `contracts.mjs` and `config.mjs`: strict version 1 boundaries and fixed limits.
- `framing.mjs`: native-endian length framing, bounded JSON/UTF-8 validation and
  incremental decoding with an awaited consumer for backpressure.
- `safe-paths.mjs`: ownership, type, mode, traversal and link checks.
- `sqlite.mjs`: isolated durable database/transaction/backup primitives.
- `ownership.mjs`: OS `flock` ownership across the spawned process lifetime.
- `native-host.mjs`: exact-origin native framing/forwarding through an injected
  connector; manifest generation is pure and registers nothing.
- `native-host-entry.mjs`: pinned-runtime entry point and bounded private local
  transport configuration; stdout carries frames only. See the
  [launcher boundary](../install/README.md).
- `probe-socket.mjs`: one active private Unix-socket connection, bounded frames
  and deadlines, no reconnect. Only the server caller holds the OS lock; native
  clients do not claim durable worker ownership. Paths are explicit and there
  is no host-triggered worker launch.
- `probe-receiver.mjs`: bounded session/body staging with durable ACKs. Explicit
  roots, identity, selected ID and caller-held ownership are required; a body
  validator is also required for conversation scope. It cannot collect a catalog,
  publish, reset a failed attempt, or
  claim production readiness. See [T02 qualification](../docs/t02-qualification.md).
  Its optional construction scope `session-only` durably forbids body work in
  that private root; default `conversation` preserves the existing full-probe
  path. Session completion is not probe completion, and changing scope requires
  a different explicitly scoped root, never resetting existing evidence.
  Session-only scope needs no body validator and ignores any supplied callback.
- `connection-check.mjs` and `connection-check-entry.mjs`: local-only global status
  endpoint and a ten-minute foreground launcher under kernel-verified `flock`.
  It reuses explicit native-host configuration, has no capture/database/identity
  implementation, and blocks all operations other than global `get_status`.

Framing validates before handing a message to a consumer. Callers must pass a
validator that **throws** on rejection. Consume input sequentially using
`await decoder.consume(chunk, accept)` and call `finish()` at EOF; do not use
an asynchronous stream `data` handler that can queue unlimited input. The
consumer is awaited before the next frame is decoded. Importing the reusable
helpers does not start a listener or browser; explicit transport calls do I/O.
The 262,144-byte serialized-message limit includes all JSON envelope fields;
Chrome's native length prefix adds four framing bytes. Response artifacts use
their original raw-byte digest, never a parsed/re-serialized JSON digest.

Path/database/process callers must supply explicit destinations. Test-only
trusted boundaries are supplied in code, never through IPC; their ancestors
are a caller trust assumption. Production callers must validate the full
ancestor chain. Filesystem checks assume the plan's same-user trust model;
they are not a defense against a malicious same-UID path-replacement race.
Existing private directories are validated, never chmod-ed into compliance.
SQLite schema checks read the main-file header when no WAL is present and
refuse a WAL missing its SHM companion before opening SQLite; this avoids
creating sidecars while diagnosing unsupported state.
A complete WAL/SHM pair is inspected through SQLite read-only; this can update
transient SHM coordination bytes, although the main database and WAL contents
remain unchanged. Read-only inspection is not a byte-frozen SHM guarantee.

SQLite tests qualify process crash recovery and backup restoration in temporary
state. They do not establish power-loss durability or qualify a future production
filesystem. The full worker schema, durable permit accounting and idempotency
belong to T03 after browser feasibility is established.
