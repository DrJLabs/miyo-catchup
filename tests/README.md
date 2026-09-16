# Tests

Run all offline checks with `npm test` on Node 22.23.2 and Linux with
`/usr/bin/flock`. No package installation is needed.

| Suite | Evidence |
|---|---|
| `repository.test.mjs` | Structure, links and complete, untruncated plan |
| `contracts.test.mjs` | Versioned configuration and wire/status/receipt validation |
| `config.test.mjs` | Explicit, bounded, private configuration loading and fixed policy |
| `protocol.test.mjs` | Actual validator/framing integration and raw-chunk digest preservation |
| `bounds.test.mjs` | UTF-8/native framing, byte caps, inert JSON and backpressure |
| `safety.test.mjs` | Private path/type/owner/mode/link rejection |
| `durability.test.mjs` | SQLite transactions/crash/backup and process lock lifetime |

These are T01 portions of AC02, AC12 and AC13. They do not satisfy the later
browser, importer, lease lifecycle or end-to-end acceptance cases. Fixtures use
temporary roots and synthetic content; fake clocks and queue-only transports
are available in `helpers/harness.mjs`. Process tests use bounded child lifetimes
and clean up only the temporary directories they create.
`helpers/schema-check.mjs` is a test-only schema oracle; it rejects unsupported
keywords rather than silently skipping them. Additional runtime byte and
cross-field checks are documented in the [contract README](../schemas/README.md).

Browser/live-import qualification remains separately authorized and does not run
in default CI. See the [fixture policy](fixtures/README.md) and canonical
[implementation checkpoint](../docs/implementation-plan.md#definition-of-done-and-current-checkpoint).
