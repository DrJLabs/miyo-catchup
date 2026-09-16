# Versioned contracts

Version 1 JSON Schemas and matching dependency-free validators are implemented
for T01. Plan revision v2 does not imply wire-protocol version 2.

| Contract | Runtime entry point | Scope |
|---|---|---|
| `config-v1.json` | `validateConfig`, `assertValidConfig`, `loadConfig` in `src/config.mjs` | Explicit binding/roots/fingerprints, fixed policy and disabled schedule |
| `protocol-v1.json` | `validateRequest`, `assertRequest`, `validateReply`, `assertReply` in `src/contracts.mjs` | Thirteen allowlisted operations and closed result/error shapes |
| `status-v1.json` | `validateStatus`, `assertStatus` | Liveness, historical evidence, progress, blockers and remaining budgets |
| `receipt-v1.json` | `validateReceipt`, `assertReceipt` | Per-request durable outcome/artifact receipt; not a release or verified-run receipt |

Validators return `{ok, errors, value}`; the `assert*` forms throw on rejection.
Always supply the originating operation when validating a successful reply.
Schema tests evaluate positive and negative fixtures independently of the
handwritten runtime validators using a test-only interpreter for the schema
keywords used here. No runtime schema framework or dependency is installed.

Runtime checks additionally enforce UTF-8 byte limits (JSON Schema measures
string characters), inert JSON, decoded chunk length, installed IANA timezone
validity, timestamp/progress ordering and relationships between fields. Config
loads read at most 64 KiB plus one overflow-detection byte and reject invalid
UTF-8, unsafe paths or permissions. A syntactically valid config does not prove
that the installed adapter fingerprints have been qualified.

Bootstrap `claim_work` carries a browser instance and either both principal/context
values or both null. It does not invent a worker lease before one is issued.
Only session work may be granted before attestation; enforcing that lifecycle
is T02/T03 work. Subsequent work/permit messages require the relevant fence.
Manual idempotency keys are UUIDs; daily keys name binding, timezone and local
due date, which the future coordinator must compare to its configured binding.

`request_failed.retry_after` carries a bounded header, including malformed
values. T03 must parse seconds/dates and persist the conservative cooldown floor
on invalid or missing input; rejecting the whole failure report could otherwise
lose a 429. Raw response bodies, auth responses and exception text are not fields.

Unknown versions/fields fail closed. These contracts do not implement the
coordinator, prove durable acceptance, or qualify a live browser/Miyo adapter.
See the [canonical plan](../docs/implementation-plan.md) for those gates.
