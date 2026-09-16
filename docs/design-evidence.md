# Public design evidence and limitations

This sanitized summary preserves design lessons from a private manual recovery.
It intentionally omits machine identity, personal paths, account/conversation IDs,
chat titles/content, database snapshots and private recovery artifacts.

## Observed lessons

- Browser-authenticated cursor catalog reads and batched full-conversation
  downloads worked without reconnecting native Miyo sync in a manual recovery.
- The catalog was not strictly ordered by update timestamp. A chronological
  cutoff or first-unchanged-page shortcut can omit changes.
- The tested Miyo 0.2.28 file-write endpoint and native watcher could dispatch
  concurrent indexing of the same file. Atomic publication with watcher-only
  indexing avoided that additional dispatcher in the manual route.
- Native integration involves Markdown, `chat_conversations` metadata and the
  dedicated chats index. File counts alone do not prove indexed freshness.
- A detached verification process stopped while Miyo continued indexing; the
  root cause was not established. Saved progress is not liveness evidence.
- Stock Miyo Capture 0.3.7's periodic sync path hands credentials to Desktop,
  rather than scheduling the separate manual ZIP-download flow. This project
  neither invokes nor modifies that sync path.

## What is not proved

The custom extension-to-local transport, complete crash recovery, current-build
adapter compatibility, every recovered file's exact vector freshness, and daily
operation still require the plan's qualification gates. Historical successful
requests are not a supported API guarantee or a promise of independent quota.

Initial runtime probes used Node 22.23.2, systemd 255 and Chrome 153. Node SQLite
basic in-memory transactions worked but remained experimental. Recheck the
actual installation and conduct crash/durability tests before claiming support.

## Read-only stock implementation comparison

The installed Miyo Capture 0.3.7 extension and the mounted Desktop service bundle
were inspected as shipped code, without invoking their runtime or reading browser
credentials, chat state or application databases. The comparison explains why
their successful authentication route is not proof of this project's page bridge:

| Component | Observed stock behavior | Consequence for this project |
|---|---|---|
| Capture background | Fetches the session directly and caches its token in extension session storage; no `scripting` permission or MAIN-world collector | Can avoid our failing script-injection boundary; the approved adaptation uses short-lived memory without the stock token cache |
| Capture native sync | Reads cookies and sends them through the stock native host | Do not adopt or invoke this credential handoff |
| Desktop service | Builds a cookie header, fetches the session/token server-side and schedules polling | Conflicts with page-local credentials and sync-off operation; not a startup fix |
| Failure handling | Separates HTTP outcomes and transport handling, but some extension errors include body snippets/raw messages | Keep distinct failure classes, without copying sensitive error text or retry behavior |

Shipped-source evidence: Capture `manifest.json`, `background.js` session/cache
and cookie-handoff paths, and `popup.js` tab creation; Desktop `server.js`
`ChatgptAdapter.fetchAccessToken`/`receiveCookies`, and `cli.js` native
`handleMessage`. Private installation paths and identifiers remain outside Git.
No vendor implementation was copied into this repository.

The initial response was more precise classification and a test composing the
real serialized collector with the browser bridge. The operator subsequently
approved a narrow extension-background authentication adaptation, superseding
packaging the additional page diagnostic. The new setup scope retains native
permits and one-shot fences, does not cache a token or export cookies, and cannot
fetch conversations. Neither source inspection nor a simulated Chrome API
establishes current live endpoint or browser compatibility.

Chrome documents that extension workers can make cross-origin requests with
[host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
and describes [extension cookie handling and policy limits](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).
This supports the implementation choice, not a guarantee of authentication in
the selected live profile. No browser cookie setting is changed to force success.

## Selected-conversation contract preparation

A further read-only inspection found that both Capture's
`chatgptAdapter.fetchConversation` and Desktop's `ChatgptAdapter.fetchConversation`
use `GET /backend-api/conversation/<selected-id>`. Their consumed response fields
include `conversation_id`, `title`, `create_time`, `update_time`, `mapping` and
`current_node`. This is distinct from the batch endpoint in our original
synthetic page fixture. Both stock request helpers send a bearer token and
cookies; neither inspected helper sets an explicit account-selection header or
establishes this project's workspace-binding guarantee. Their retry, token cache,
rendering and synchronization code are not adopted.

The new offline draft checks the selected ID and complete mapping structure,
without assuming that this source evidence qualifies a live response. It is not
registered, installed or network-capable. The proposed future body path would
use a fresh, validated personal-account token in short-lived background memory
and omit cookies on the body request, avoiding implicit cookie-based workspace
selection. The operator subsequently approved that narrow authentication/context
change. Its separate collector/receiver scope is implemented and being qualified;
this source evidence does not by itself establish a successful live body request.

The [Fetch standard's credentials mode](https://fetch.spec.whatwg.org/#concept-request-credentials-mode)
controls browser-managed credentials such as cookies; its
[HTTP-network request steps](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)
distinguish those from an explicitly supplied authorization header. This supports
the proposed browser mechanics, not a claim that ChatGPT accepts cookie-free
body requests or that its undocumented backend scope is qualified. A failure
must not trigger a cookie-bearing fallback, token refresh, account switch or
automatic retry.

## Evidence policy

Operators retain raw evidence in private state outside this repository. Public
tests use synthetic fixtures. Release summaries may cite sanitized outcomes and
software versions, never private chat payloads or credentials. Do not run old
recovery helpers blindly: their diagnostic commands can write private receipts.
