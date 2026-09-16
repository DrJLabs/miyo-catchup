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
| `page-collector.test.mjs` | Synthetic MAIN-world serialization, credential non-export, permits and bounded pulls |
| `browser-bridge.test.mjs` | Fake Chrome owned-document lifecycle and navigation/restart refusal |
| `probe-client.test.mjs` | Separate session/body requests, session-only stop boundary, strict sanitized-session forwarding and lost ACK/port behavior |
| `native-host.test.mjs` | Exact origin, native framing, validated replies and transport backpressure |
| `native-host-entry.test.mjs` | Closed private config, runtime/origin guards, literal launcher quoting and sanitized CLI failures |
| `probe-socket.test.mjs` | Real temporary Unix sockets, frame/path/deadline checks and connection ownership |
| `probe-socket-process.test.mjs` | Native entry to socket/receiver under real process-lifetime flock; competing start and crash/restart |
| `extension-package.test.mjs`, `probe-controller.test.mjs` | MV3 package scope, explicit popup control, durable fences and no unqualified/autostart effects |
| `connection-popup.test.mjs` | Explicit local-only status check, strict disabled endpoint profile, sender/gesture guards, sanitized failures and popup races |
| `connection-check.test.mjs`, `connection-check-entry.test.mjs` | Status-only refusal of capture operations, foreground lock evidence, contention, bounded lifetime and cleanup |
| `probe-receiver.test.mjs` | Private one-probe staging, identity/fences, durable scope/receipts and fail-closed restart |
| `probe-integration.test.mjs` | Actual collector through native framing and a real temporary Unix socket to SQLite staging in conversation and session-only scopes; exact digest and secret sentinels |

These cover T01 portions of AC02, AC12 and AC13 plus synthetic T02 portions of
AC01, AC02, AC06 and AC13. They do not satisfy real Chrome, importer, full T03
lease lifecycle or live end-to-end acceptance cases. Fixtures use
temporary roots and synthetic content; fake clocks and queue-only transports
are available in `helpers/harness.mjs`. Process tests use bounded child lifetimes
and clean up only the temporary directories they create.
`helpers/schema-check.mjs` is a test-only schema oracle; it rejects unsupported
keywords rather than silently skipping them. Additional runtime byte and
cross-field checks are documented in the [contract README](../schemas/README.md).

Browser/live-import qualification remains separately authorized and does not run
in default CI. See the [fixture policy](fixtures/README.md) and canonical
[implementation checkpoint](../docs/implementation-plan.md#definition-of-done-and-current-checkpoint).
