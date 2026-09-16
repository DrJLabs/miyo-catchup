# Chrome extension boundary

The approved selected-body source path is separate from setup and page probes.
Private `backgroundSelectedConfig` pins principal, personal account context and
one conversation. **Fetch selected conversation once** invokes the fixed
background collector only after a trusted popup gesture. A fresh session and
one cookie-free body GET each require durable native permission. Tokens remain
in attempt-local memory for at most 60 seconds, are dropped at body dispatch,
and never enter browser storage or native/popup output. Separate persisted
fences preserve all previous attempts; failures cannot retry. Public
configuration is undefined. Completion means `background_probe_complete`,
not workspace attestation, catalog completion, import or indexing.

T02 source modules provide a bounded, fixed MAIN-world collector, an explicitly
owned-document bridge, and a sequential protocol-v1 probe client. `manifest.json`
now defines an MV3 qualification package with an explicit popup and
background controller. No scheduler runs, and no
live ChatGPT adapter is qualified. Startup installs only an internal message
handler; it does not create a tab, native connection, alarm or upstream request.

The full session/body adapter is synthetic-only on a reserved synthetic origin;
real ChatGPT body capture fails closed. The separately scoped background setup
inspection described below is enabled only by a private constructor/package
configuration and can inspect one session only. Ordinary page-collector
credentials remain in the page closure; the background path retains any
short-lived session credential material only in extension memory, with no token
cache, Cookies API access or native credential export.
The bridge retains sanitized ownership evidence and does not automatically close
tabs, adopt old tabs or recover an uncertain browser session by refetching.

The controller accepts only the exact packaged popup sender and explicit Start
gesture, validates private configuration before browser effects, and persists a
one-attempt fence. Stored in-progress or malformed evidence blocks restart. The
popup shows fixed status labels, not identifiers, body content or raw errors.
Startup failures retain a fixed failure code across popup/service-worker restart;
blocked attempts remain terminal and never become retryable. Older failed records
can expose only their last saved tab/document milestone, not the discarded cause.
Reading this diagnostic does not open a tab, connect to native messaging, fetch,
rewrite the old record or clear its fence.
Its full-capture adapter registry is empty: setting `enabled` in storage cannot
enable live capture. No private configuration or stable pairing key is shipped.

The separate **Check local connection** action sends one local-only `get_status`
request and closes its native port. It recognizes only a fresh capture-disabled
qualification endpoint; no browser page is created and no configuration or
capture fence is changed. Its result is not a capture success or a persistent
worker-health claim. Opening the popup does not run this check automatically.
The canonical checkpoint records private packaging and pairing progress.

The independently gated **Diagnose startup (no fetch)** action opens a new owned
tab only after an explicit click and a prior terminal failed setup attempt. It
uses separate one-shot fence/document records and leaves the old evidence intact.
Its sticky startup-only collector can initialize and abort but cannot dispatch
session or body work; no native connection or receiver is involved. Normal
ChatGPT page-load traffic may occur. All results are fixed codes, and every
attempt remains locked afterward, including on failure or worker restart.
`startupDiagnosticEnabled` is false in the public package and can only be set
in a separately approved private package. Success is not identity qualification
and never unlocks the ordinary inspection or capture controls.

The separately approved v2 diagnostic is selected only by the private
`startupDiagnosticRevision = 2` setting. It requires the first diagnostic's
saved generic initialization failure and uses new fixed fence/document keys;
neither old attempt is reset. Its popup label includes `v2` and distinguishes
script rejection, timeout, changed document, missing/malformed result and
collector rejection. Old generic results remain honestly unresolved. The public
default remains revision 1 with diagnostics disabled. This remains source-only
diagnostic code and is superseded by the current private background setup
packaging; no v2 diagnostic run is implied.

The source-only `runSessionCheck` path uses the same permitted protocol flow but
advertises only session/chunking capabilities, commits one sanitized session
receipt, and stops with `session_check_complete`. It never claims body work.
This is not yet wired into the installed popup or backed by a live adapter.
Both clients bound session outcomes to one 16 KiB chunk and reject unexpected
identity/context fields or discarded JSON bytes before native forwarding.

The current approved setup path is deliberately narrower than a capture adapter.
Only a private constructor/package configuration may expose **Inspect session in
extension**; the public package remains disabled. After a local permit and
dispatch acknowledgement it performs exactly one authenticated session `GET`,
then transfers only a bounded sanitized principal/context outcome. It never
fetches a conversation or body. The unique `collector_instance_id` used by
this path is not a page `document_id`, and no token cache, Cookies API access or
native credential export is permitted. An observed backend context is a
candidate for later qualification, not workspace attestation. The receiver
terminates at `background_setup_complete`; the popup reports
`background_setup_inspection_complete`, and ordinary Start remains locked.
Existing failed and terminal records are preserved across restart. See the
operator-approved setup exception in the plan.

See [plan section 4](../docs/implementation-plan.md) for minimum permissions,
credential isolation, owned-tab lifecycle and transport bounds. Start with the
T02 proof after the T01 contracts, not a broad extension framework. The
[qualification boundary](../docs/t02-qualification.md) records remaining work
and authorization without claiming synthetic tests are Chrome evidence.
