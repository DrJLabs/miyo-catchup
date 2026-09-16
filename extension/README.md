# Chrome extension boundary

T02 source modules provide a bounded, fixed MAIN-world collector, an explicitly
owned-document bridge, and a sequential protocol-v1 probe client. `manifest.json`
now defines an MV3 qualification package with an explicit popup and
background controller. No scheduler runs, and no
live ChatGPT adapter is qualified. Startup installs only an internal message
handler; it does not create a tab, native connection, alarm or upstream request.

Only the synthetic test adapter is enabled on a reserved synthetic origin;
real ChatGPT initialization fails closed. Credentials remain in the page closure.
The bridge retains sanitized ownership evidence and does not automatically close
tabs, adopt old tabs or recover an uncertain browser session by refetching.

The controller accepts only the exact packaged popup sender and explicit Start
gesture, validates private configuration before browser effects, and persists a
one-attempt fence. Stored in-progress or malformed evidence blocks restart. The
popup shows fixed status labels, not identifiers, body content or raw errors.
Its reviewed-adapter registry is empty: setting `enabled` in storage cannot
enable live capture. No private configuration or stable pairing key is shipped.

The separate **Check local connection** action sends one local-only `get_status`
request and closes its native port. It recognizes only a fresh capture-disabled
qualification endpoint; no browser page is created and no configuration or
capture fence is changed. Its result is not a capture success or a persistent
worker-health claim. Opening the popup does not run this check automatically.
The canonical checkpoint records private packaging and pairing progress.

See [plan section 4](../docs/implementation-plan.md) for minimum permissions,
credential isolation, owned-tab lifecycle and transport bounds. Start with the
T02 proof after the T01 contracts, not a broad extension framework. The
[qualification boundary](../docs/t02-qualification.md) records remaining work
and authorization without claiming synthetic tests are Chrome evidence.
