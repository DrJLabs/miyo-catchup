# Security and private data

The project has offline foundations and a bounded, live-qualified T02
one-conversation browser-to-private-staging proof; no release is qualified for
general capture, Miyo import or production use.

Do not put vulnerabilities involving credentials or private data into public
issues. Use GitHub private vulnerability reporting if it is available for the
repository; otherwise arrange a private channel with a maintainer before sharing
details. Do not include real cookies, tokens, conversation exports, account IDs,
production databases or raw logs in an initial report.

## Required boundaries

- Ordinary page-collector authentication material remains in the browser page
  context. The separately approved background setup and selected-body paths may hold short-lived
  session credential material in extension memory only; it has no token cache,
  Cookies API access or native credential export.
- The native host permits only the paired custom extension; no HTTP listener.
- Local components run as the installing user with restricted files/directories.
- The same-user account and genuine first-party page are within the trust model;
  this is not a sandbox against a compromised user account or page.
- Background setup is private-constructor configuration only. After a local
  permit and dispatch acknowledgement it makes exactly one bounded session
  `GET`, never a conversation/body request, and transfers only sanitized
  identity evidence. Its `collector_instance_id` is distinct from a page
  document identity; no identity is reused across those paths.
- An observed backend account context is a candidate for later qualification,
  not workspace attestation. The background receiver terminates at
  `background_setup_complete` and the UI reports
  `background_setup_inspection_complete`; terminal and failed records are
  retained rather than retried or overwritten.
- One worker owns pacing, durable cooldowns and publication. Unknown versions,
  unsafe paths, identity conflicts and uncertain dispatch fail closed.
- The separate `background-selected-conversation` proof uses a fresh session
  token bound to the pinned personal account for one cookie-free body GET. The
  token is held for at most 60 seconds (never beyond expiry), dropped at body
  dispatch, and never cached or exported. Separate durable permits, independent
  fences/roots and exact selected-ID validation are required. There is no cookie
  fallback, refresh, automatic retry or claim about the visible tab's workspace.
  Only validated bounded conversation bytes enter private staging, not Miyo.
- Stock Miyo sync and existing native-host registrations remain untouched.
- Only Miyo's watcher dispatches indexing. No automatic repair or restart path.

See the [implementation plan](docs/implementation-plan.md) for the full threat
boundary, resource limits, recovery semantics and prohibited side effects.

`.gitignore`, basic repository checks and automated secret scans are defense in
depth, not a substitute for reviewing every publicly staged file.
