# Chrome extension boundary

T02 source modules provide a bounded, fixed MAIN-world collector, an explicitly
owned-document bridge, and a sequential protocol-v1 probe client. `manifest.json`
now defines an MV3 qualification package with an explicit popup and
background controller. No scheduler runs, and no
live ChatGPT adapter is qualified. Startup installs only an internal message
handler; it does not create a tab, native connection, alarm or upstream request.

The full session/body adapter is synthetic-only on a reserved synthetic origin;
real ChatGPT body capture fails closed. The separately scoped, explicitly
configured setup inspection described below can inspect one session only.
Credentials remain in the page closure.
The bridge retains sanitized ownership evidence and does not automatically close
tabs, adopt old tabs or recover an uncertain browser session by refetching.

The controller accepts only the exact packaged popup sender and explicit Start
gesture, validates private configuration before browser effects, and persists a
one-attempt fence. Stored in-progress or malformed evidence blocks restart. The
popup shows fixed status labels, not identifiers, body content or raw errors.
Its full-capture adapter registry is empty: setting `enabled` in storage cannot
enable live capture. No private configuration or stable pairing key is shipped.

The separate **Check local connection** action sends one local-only `get_status`
request and closes its native port. It recognizes only a fresh capture-disabled
qualification endpoint; no browser page is created and no configuration or
capture fence is changed. Its result is not a capture success or a persistent
worker-health claim. Opening the popup does not run this check automatically.
The canonical checkpoint records private packaging and pairing progress.

The source-only `runSessionCheck` path uses the same permitted protocol flow but
advertises only session/chunking capabilities, commits one sanitized session
receipt, and stops with `session_check_complete`. It never claims body work.
This is not yet wired into the installed popup or backed by a live adapter.
Both clients bound session outcomes to one 16 KiB chunk and reject unexpected
identity/context fields or discarded JSON bytes before native forwarding.

The separate setup-inspection path is deliberately narrower than a capture
adapter. An explicitly configured private package may expose **Inspect signed-in
session** to compare one expected principal and privately record the observed
personal-account context. Its public configuration contains no identity values.
It performs one permitted session request, never a conversation request, and
completion leaves ordinary Start disabled. Missing, ambiguous or changing
workspace evidence fails closed; raw authentication responses, tokens and
cookies stay inside the page. A fresh root/configuration is needed for a later
strictly bound proof. See the operator-approved setup exception in the plan.

See [plan section 4](../docs/implementation-plan.md) for minimum permissions,
credential isolation, owned-tab lifecycle and transport bounds. Start with the
T02 proof after the T01 contracts, not a broad extension framework. The
[qualification boundary](../docs/t02-qualification.md) records remaining work
and authorization without claiming synthetic tests are Chrome evidence.
