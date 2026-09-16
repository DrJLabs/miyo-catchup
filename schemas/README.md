# Versioned contracts

The separately approved selected-body proof adds the optional capability
`background_selected_body` alongside `background_session_check`. Only the
`background-selected-conversation` receiver accepts both; setup/page receivers
reject promotion. Background dispatch uses `collector_instance_id`, not a
fabricated document identity. Existing protocol-v1 framing/permits/chunks and
receipts are reused. A matched session sets scope-local `selected_body_ready`
but never visible-workspace attestation; completion is `background_probe_complete`.

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
Successful `commit_result` receipts require `committed` plus artifact evidence;
the generic `accepted` outcome cannot acknowledge this operation prematurely.

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

The private background setup path uses the existing version-1 permit, dispatch,
chunk and commit envelopes. It issues one session `GET` only after the permit
and durable dispatch acknowledgement, identifies the source with a unique
`collector_instance_id` (not a page `document_id`), and transfers only the
sanitized principal/context outcome. No token or cookie material is a schema
field or native export. The resulting context is candidate evidence, not
workspace attestation; receiver completion is `background_setup_complete` and
the popup's corresponding terminal state is
`background_setup_inspection_complete`. The public configuration leaves this
path disabled.

The separately scoped `background-selected-conversation` path adds the
`background_selected_body` hello capability alongside
`background_session_check`. It uses the same bounded session/body envelopes but
requires exact configured principal/context evidence before the body permit,
uses `collector_instance_id` for both dispatches, keeps `attested` false for
visible-workspace semantics, and terminates at `background_probe_complete`.
Its dedicated private entry requires the explicit scope, extension-background
execution context, non-null binding context and a separate root; setup roots
cannot be promoted.

`request_failed.retry_after` carries a bounded header, including malformed
values. T03 must parse seconds/dates and persist the conservative cooldown floor
on invalid or missing input; rejecting the whole failure report could otherwise
lose a 429. Raw response bodies, auth responses and exception text are not fields.

Unknown versions/fields fail closed. These contracts do not implement the
coordinator, prove durable acceptance, or qualify a live browser/Miyo adapter.
See the [canonical plan](../docs/implementation-plan.md) for those gates.
