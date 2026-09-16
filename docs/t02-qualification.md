# T02 qualification boundary

T02 is **in progress, not live-qualified**. The operator has supplied screenshot
evidence of a passing Chrome-to-native local-status check with capture disabled;
this is not an authenticated capture proof. The qualification package and synthetic
tests below do not establish that proof. The single progress
checkpoint remains in [the implementation plan](implementation-plan.md#definition-of-done-and-current-checkpoint).

## Implemented boundaries

- `extension/page-collector.mjs`: fixed serializable MAIN-world function;
  separately permitted session/body operations, page-local credentials, bounded
  response buffering and pull/release transfer. Only a reserved synthetic-origin
  adapter is available. Real ChatGPT initialization fails closed.
- `extension/browser-bridge.mjs`: explicit creation of one inactive owned tab,
  top-frame/document targeting, persistent sanitized ownership evidence, and
  rejection after navigation or restart uncertainty. It never adopts existing
  tabs. It deliberately leaves the qualification tab for operator cleanup:
  Chrome has no atomic close-by-document operation, so no automatic close can
  accidentally target a user's replacement document.
- `extension/probe-client.mjs`: sequential protocol-v1 control flow for one
  session check and one pinned body; each waits for its durable dispatch ACK.
  At most one chunk is awaiting acknowledgement. Lost transport/ACK stops the
  flow; it cannot reconnect, refetch, enumerate a catalog, or publish.
- `extension/manifest.json`, `background.mjs`, `probe-controller.mjs` and popup:
  minimal MV3 qualification package, exact internal-popup sender, explicit Start
  gesture, closed private configuration and persistent one-attempt fence. Startup
  has no native/tab/alarm/fetch effect. The reviewed live-adapter registry is
  empty; storage configuration alone cannot enable real-page capture.
- `extension/connection-check.mjs`: explicit popup-only local transport check.
  It sends one protocol-v1 `get_status` request, accepts only fresh status from
  the capture-disabled qualification endpoint, and closes the native port.
  It cannot open a page, fetch ChatGPT, alter capture configuration/fences or
  enable Start. Passing this check is not identity or capture qualification.
- `src/connection-check.mjs`, `connection-check-entry.mjs`: separate local-only
  `get_status` endpoint and explicit foreground launcher. Every other protocol
  operation is blocked. The launcher reuses the private native-host configuration,
  holds an OS `flock`, verifies inherited kernel lock evidence, and expires after
  ten minutes. It does not launch from the native host or install a service.
- `src/native-host.mjs`: exact caller-origin and manifest-object validation,
  bounded native framing, serial forwarding through an injected worker
  connector, and sanitized transport failures. It does not register a host or
  launch a worker.
- `src/native-host-entry.mjs`, `install/native-host-launcher.mjs`: bounded private
  transport configuration and a pure literal-path launcher renderer. Node is
  pinned to 22.23.2; caller origin is checked before any worker connection. There
  is no installer, automatic registration or worker startup.
- `src/probe-socket.mjs`: explicit private Unix socket, one active connection,
  framed serial requests, bounded deadlines and no retry/reconnect. The server
  caller must hold the OS lock; clients do not acquire or assert that lock.
  Receivers must be bounded and synchronous (as the T02 SQLite receiver is), or
  honor the supplied AbortSignal before further effects. A pending receiver's
  timeout/port loss aborts cooperatively and fences the listener against new
  clients. It is not proof of rollback or a way to preempt arbitrary local code.
- `src/probe-receiver.mjs`: one-probe private staging and durable receipt
  harness, with explicit roots, binding, selected conversation, body validator,
  and caller-held ownership. It is not the T03 coordinator or a running socket
  service. A failed/uncertain probe cannot reset into another attempt, including
  after the persisted Retry-After deadline. Monotonic/boot discontinuities block
  new dispatch; stored success receipts must still have matching private bytes.

Session transfer contains only `{principal_id, context_id}` after page-side
validation. Conversation bytes are transferred with their original UTF-8 digest,
not a reserialized JSON digest. Completion means `probe_complete` only; it never
means catalog-complete, imported, indexed, or verified.

## Local connection checkpoint

The popup's **Check local connection** button is separate from **Start selected
probe**. Opening the popup does not initiate native messaging. The explicit
connection check uses the existing `get_status` operation, which is permitted
without a compatible capture configuration. It recognizes only the dedicated
`0.0.0-t02-connection` endpoint, with zero upstream budgets and no active run;
an unavailable, stale, malformed or different endpoint cannot show a pass.

This isolates a manual transport check: load the updated unpacked package and
click the connection-check button while the private host/foreground endpoint
is running. A pass establishes the browser-to-native local transport
path at that instant only. The foreground endpoint has no session/body handler,
cannot issue leases or permits, and must not be mistaken for the T03 coordinator
or the one-conversation staging receiver. Account/workspace qualification and
the live adapter remain separate prerequisites for Start.

## Offline checks

Use the pinned Node version; there are no dependencies to install:

```bash
node --test tests/page-collector.test.mjs tests/browser-bridge.test.mjs tests/probe-client.test.mjs tests/native-host.test.mjs tests/probe-receiver.test.mjs tests/probe-integration.test.mjs
npm run check
npm test
git diff --check
```

All inputs are synthetic, including credentials used as non-export sentinels.
Browser API behavior is simulated; no real browser profile, authenticated
request, native registration, production path, or Miyo database is exercised.
The vertical test includes a real temporary Unix socket and a large synthetic
Unicode response. A separate child-process test holds the actual OS lock across
the foreground receiver lifetime and checks contention and crash recovery.
Popup markup/controller checks do not establish live keyboard or visual behavior.
Temporary-root trust exceptions and injected validators are test/harness code,
never caller-selectable wire options.

## Remaining A2 gate

Before a live proof:

1. Authorize the exact custom extension/native-host pairing and select **one**
   conversation privately. Keep its ID, account evidence and captured bytes out
   of Git, public CI, issues and PRs. Native Miyo sync stays disconnected.
2. Establish the current session-principal-to-Miyo-account mapping and observed
   personal/default workspace context. Qualify the actual session/body shape,
   content type, fixed request requirements and compatibility fingerprint. A
   configured context is not observed evidence; do not add guessed headers or
   alternate authentication/profile mechanisms.
3. Add the reviewed adapter to the prepared MV3 package. Assemble a reviewed
   private release, exact extension-ID registration, pinned launcher and
   foreground receiver under a process-lifetime OS `flock`. The transport source
   and launcher renderer do not install or register themselves. Verify the full
   release-path ancestor chain; do not launch installed code from a checkout
   with group/other-writable ancestors or relax those checks for convenience.
4. Exercise one separately permitted session check and the selected body. Prove
   the exact private-staging digest, token non-export, context binding, response
   limits, lost-port handling, and owned-document lifecycle. Retain private
   evidence and explicitly record browser-generated traffic outside collector
   pacing. Do not run a catalog scan or publish chats.

Only successful A2 evidence closes T02. T03 and the larger importer/scheduler
remain downstream. No change here authorizes Miyo writes, service activation,
daily scheduling, reconnect/resync, or stock-extension modification.

### Retained evidence is not a live adapter

Read-only inspection of the retained recovery helper confirmed the historical
session fields `accessToken` and `user.id`, bearer authorization, and the fixed
session/body endpoint route. That helper checks principal equality but does not
observe or validate the active workspace context. It therefore cannot justify
turning a configured personal/default context into an observed attestation.

Retained body/catalog files contain helper wrappers around already-parsed JSON,
not original HTTP response bytes or complete content-type/header evidence. Their
field shapes can inform synthetic fixture design, but cannot establish a byte-exact
wire fingerprint, current session schema, or live context mapping. No private
identifiers, conversation text, authentication material, or recovery artifacts
were copied into the repository. The production collector remains disabled until
the selected conversation/profile and current context contract are qualified.

## Official API basis, not qualification evidence

Chrome documents native-endian framing, a caller-origin argument and exact
`allowed_origins`; the host module applies the stricter application frame cap.
See [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

`executeScript` serializes functions without their module closure; document IDs
and MAIN-world targeting are documented from Chrome 106 and 95 respectively.
The collector is self-contained and the bridge targets a known document after
the initial top-frame check. See [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting).

Creating/managing a tab does not itself require the broad `tabs` permission;
the scoped ChatGPT host permission provides relevant access. Actual behavior
still needs the selected Chrome qualification. See [Chrome tabs permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions).

Service workers can terminate unexpectedly. Durable worker state and retained
ownership/failure evidence, rather than an in-memory heartbeat or automatic
reconnect, govern recovery. See [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

Node's Unix-socket path length is OS-dependent and its server close operation
removes the socket path. The transport rejects overlong paths before binding and
checks lock ownership and socket identity before close. See the pinned
[Node 22.23.2 IPC documentation](https://nodejs.org/download/release/v22.23.2/docs/api/net.html#identifying-paths-for-ipc-connections).
