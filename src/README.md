# Local runtime foundations

The [implementation plan](../docs/implementation-plan.md) is authoritative.
T01 provides reusable offline primitives; no working CLI, coordinator, native
host, collector or importer is included yet.

- `contracts.mjs` and `config.mjs`: strict version 1 boundaries and fixed limits.
- `framing.mjs`: native-endian length framing, bounded JSON/UTF-8 validation and
  incremental decoding with an awaited consumer for backpressure.
- `safe-paths.mjs`: ownership, type, mode, traversal and link checks.
- `sqlite.mjs`: isolated durable database/transaction/backup primitives.
- `ownership.mjs`: OS `flock` ownership across the spawned process lifetime.

Framing validates before handing a message to a consumer. Callers must pass a
validator that **throws** on rejection. Consume input sequentially using
`await decoder.consume(chunk, accept)` and call `finish()` at EOF; do not use
an asynchronous stream `data` handler that can queue unlimited input. The
consumer is awaited before the next frame is decoded. These helpers neither
write stdout nor connect to a browser or socket.
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
