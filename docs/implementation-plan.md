# miyo-catchup: implementation specification and delivery plan (v2)

## Document control and execution authority

- **Plan ID:** `miyo-chatgpt-daily-catchup-v2`
- **Prepared:** 2026-09-15; public standalone edition adapted from the operator's v2 specification.
- **Status:** implementation-ready for the sequenced work below; browser-origin feasibility and live deployment remain qualification gates, not assumed successes.
- **Predecessors:** original v1 and operator v2 drafts retained unchanged outside this repository; see [ownership and migration](repository-ownership.md).
- **Canonical repository:** [DrJLabs/miyo-catchup](https://github.com/DrJLabs/miyo-catchup).
- **Implementation destination:** this standalone repository; extension, worker and contracts share one release boundary.
- **Bootstrap authorization:** create this scaffold, transfer public-safe specifications, initialize Git, and publish the initial public repository. This does not authorize functional collector/worker implementation, installation, native-host registration, service activation, browser capture, or live archive mutation.
- **Implementation authorization:** the operator subsequently authorized implementation. The current source/test work is A1; browser pairing/capture, live import, installation and activation retain their A2–A5 gates below.
- **Authority on adoption:** this is the canonical plan for future implementation. It supersedes conflicting wording in the operator drafts without changing their historical records. Old runbooks are evidence, not permission to reconnect native sync.

**Recommended direction:** retain the separate Chrome extension plus a durable local worker. Do not wrap the interactive recovery script in a timer, fork Miyo Capture, introduce an HTTP listener, or add an orchestration framework.

This specification separates binding outcomes and invariants, settled technical decisions, and implementation discretion. Requirement IDs are the review baseline. Task/file suggestions may be refined without changing required behavior. A material change to permissions, trust boundaries, data ownership, capture scope, or acceptance requires an explicit plan amendment and appropriate authorization; failing tests are not grounds to weaken acceptance.

### Authorization boundaries

| Level | What a later authorization may cover | Not implied |
|---|---|---|
| A0 — repository bootstrap | Public-safe plan, supporting docs, folder scaffold, offline repository checks, initial Git commit and public repository push | Functional collector/worker implementation or any runtime change |
| A1 — implement offline | Source, synthetic fixtures, local tests, documentation; temporary isolated test state | Accessing ChatGPT, registering a host, touching live Miyo data |
| A2 — browser proof | Explicit extension/native-host pairing and one selected authenticated conversation to private staging | Publishing chats or activating daily scheduling |
| A3 — live import qualification | Backed-up new/updated canaries, then explicitly approved larger runs | Repairing Miyo, restoring its database, reconnecting sync |
| A4 — supervised service qualification | Installing/starting this worker and testing its request service, timer still disabled | Enabling a daily production timer |
| A5 — daily activation | Approved schedule, enablement, and first scheduled-run observation | Broadening capture scope, bypassing limits, auto-repair |

A later request can authorize several levels together explicitly. Do not repeatedly ask for actions already covered. A missing schedule choice does not block A1. The operator is the approval owner; the implementing agent owns routine design, tests, and evidence within its authorization.

**Approved background-setup amendment (2026-09-16):** after comparing the
installed stock extension and Desktop, the operator authorized relaxing
page-only credential isolation where safe. This permits one separately scoped
`background-setup-inspection`, not stock cookie synchronization. Its fixed HTTPS
session request runs in the trusted extension worker with browser-managed
credentials and the existing host permission. Raw authentication responses and
tokens may exist only in short-lived worker memory: no token cache, cookies API,
native credential export, popup/log output or credential persistence. Native
durable leases, permits, dispatch acknowledgements and cooldowns remain required.
The background instance has a fresh `collector_instance_id`, never a fabricated
Chrome `document_id`, and a new private staging scope/root and extension fence.
Both prior failed page attempts remain preserved. Sanitized principal/personal
backend-context evidence is only a point-in-time candidate, not an attestation
of the visible page's workspace selection. No body work or scope promotion is
enabled; subsequent body qualification still needs a reviewed context-binding
contract. This narrow amendment supersedes page-only wording for this scope
alone and does not authorize stock sync, publication, services or scheduling.

**Approved selected-body amendment (2026-09-16):** the operator approved one
fresh background session check followed by one selected-conversation
`GET /backend-api/conversation/<id>`, bound to the verified personal backend
account rather than the visible tab's workspace. Each request requires its own
durable permit and dispatch ACK. The body request uses the validated token with
`credentials: 'omit'`; there is no cookie fallback, account switching, guessed
account header, refresh, automatic retry or catalog request. Token retention is
attempt-local memory only, at most 60 seconds and never beyond token expiry;
the reference is dropped at body dispatch or any terminal/abort path. This is
scope `background-selected-conversation`, with a new private root and separate
extension fence. Prior setup/page roots cannot be promoted. Exact session
principal/context checks authorize this scope's body only, not workspace
attestation. Original bounded UTF-8 body bytes may be staged privately after
contract validation. No credentials leave browser memory; no Miyo write,
publication, service, scheduling or unrestricted capture is authorized.

## 1. Verified baseline, evidence limits, and changes from v1

### 1.1 Evidence baseline and public scope

The original v2 design drew on a manual sync-off recovery and read-only local
inspection. This public edition transfers the engineering conclusions, not the
operator's host inventory, private paths, conversation counts, identifiers,
receipts, database snapshots or recovery scripts. See [design evidence](design-evidence.md)
and [repository ownership](repository-ownership.md). [L1–L9]

| Item | Design baseline | Consequence |
|---|---|---|
| Implementation | Specification plus repository scaffold only | All runtime components and commands below remain future deliverables |
| Runtime | Node 22.23.2, Linux user services and Chrome MV3 | Pin and qualify actual deployment versions; no implicit dependency installation |
| Node SQLite probe | Prior in-memory transaction probe succeeded and emitted an experimental warning | Availability only, not crash-durability qualification |
| Scheduling | Daily local-time request with jitter proposed | Confirm the operator's timezone/time before A5; no timer installed or enabled |
| Native sync | Manual recovery demonstrated a disconnected-sync route | Recheck disconnected state throughout live qualification |
| Recovery evidence | File/metadata checks and saved receipts are partial, potentially stale evidence | Never infer current hashes, vectors, retrieval or worker liveness from them |
| Miyo compatibility | Prior route used Miyo 0.2.28 | T01/T05 must qualify the actual installed bundle/schema/renderer fingerprints |

Bootstrap work does not repeat live capture, native import, full vector
verification or retrieval canaries. The earlier helpers are not shipped as the
new implementation: even their diagnostic branches could write private
receipts, and their behavior does not meet the complete v2 contract.

### 1.2 Why v2 changes the execution contract

v1 already correctly chose full-catalog enumeration, browser-held credentials, watcher-only indexing, durable cooldowns, separate download/import/index states, and staged rollout. Preserve those decisions. v2 closes these remaining ambiguities:

1. **Authentication requests count too.** The inspected manual browser helper obtains a session before each catalog/body request. That implementation is not a reusable single-request permit boundary. Each programmatic session, catalog, or body request needs its own paced permit.
2. **Database identity is not account-scoped.** The observed Miyo primary key is `(platform, conversation_id)`, not `(platform, account_id, conversation_id)`. An existing row owned by another or an unbound account must not be silently reassigned.
3. **Lease expiry is not proof that a browser request ended.** Persist an uncertain-dispatch blocker until the old execution context is safely drained; do not grant competing work merely because time passed.
4. **A scan has no stable snapshot guarantee.** Complete enumeration and a precisely stated observation interval are required; empty-but-continuing pages, moving timestamps and cursor expiry have explicit outcomes.
5. **Cross-resource publication needs a recovery matrix.** A file rename, Miyo transaction, and worker receipt are not one transaction. Pause/stop must preserve recovery ownership after a rename.
6. **Limits must apply before serialization/allocation.** Chunk data through the page-to-extension leg as well as native messaging. A huge `executeScript` return is not fixed by chunking it later.
7. **No-op and verification need distinct meanings.** Do not rewrite identical bytes, infer new messages from an update timestamp, accept obsolete vector generations, or claim whole-corpus verification from run-scoped tests.
8. **Feasibility precedes infrastructure.** Prove the standalone browser-to-local path before completing the full scheduler/importer. Offline tests and live deployment have different exit criteria.

## 2. Product contract: goals, scope, and invariants

### 2.1 Desired outcome

Daily or on-demand, the tool discovers every item exposed by the qualified catalog for one configured browser identity/context, retrieves only needed new/newer/missing bodies, publishes native-compatible Miyo Chats, and independently proves that the selected versions are indexed. A repeat over unchanged inputs performs no body downloads and no live Markdown rewrites.

Success is a **verified run scoped to its catalog observation interval**, not an assurance that all remote history is visible, that all local chats were reverified, or that no conversation changed after the scan.

### 2.2 Binding requirements

| ID | Requirement |
|---|---|
| R01 | Use the existing signed-in Chrome profile; keep native Miyo ChatGPT sync disconnected and leave stock Miyo Capture unchanged. |
| R02 | Keep tokens/cookies/authentication responses in the browser page context or the explicitly approved background setup/selected-body worker's short-lived memory; never cache, persist or forward credentials to native/popup/logs. Bind capture and publication to one explicitly paired principal/context. |
| R03 | Complete and checkpoint the full qualified catalog without chronological shortcuts; state coverage limits honestly. |
| R04 | Select new, newer or missing-body items without downgrading known versions; preserve unchanged files and local records absent remotely. |
| R05 | Enforce one worker, one active account job, fenced browser work, bounded requests and durable cooldowns across every trigger/restart. |
| R06 | Recover committed results and partial publication without duplicate imports, blind replay, silent conflicts, or whole-database restore. |
| R07 | Preserve qualified native rendering, existing filenames/project assignments, and Miyo manifest compatibility; watcher is the sole index dispatcher. |
| R08 | Prove current bytes, manifest fields, indexed metadata, exact current-generation vectors and qualified native retrieval before claiming verification. |
| R09 | Expose live/stale status, separate progress counts, pause/cooldown/blockers, coverage times and last verified capture without misleading completion. |
| R10 | Coalesce daily/manual requests and defer browser-closed work; scheduler/verifier outlive the initiating terminal or agent. |
| R11 | Fail closed on unknown schemas, identities, unsafe paths, missing durable state, excessive resources and incompatible upgrades. |
| R12 | Preserve private evidence and original recovery artifacts; apply explicit ownership, storage limits and safe operational rollback. |
| R13 | Make dry-run non-publishing and immutable; neither dry-run nor partial work advances verified-capture time. |
| R14 | Qualify in bounded vertical slices, including real Chrome proof and one new/one updated native canary; no production rate-limit induction. |
| R15 | Treat page responses/titles/messages as data, not commands, instructions, arbitrary URLs, paths, headers, or SQL. |
| R16 | Maintain traceable requirement-to-test evidence and invalidate affected approval/evidence after material spec, version or target changes. |

### 2.3 Non-goals and preserved boundaries

No Miyo or stock extension fork; cookie export; credential handoff; native reconnect/resync; second browser profile; remote-debugging port; automated login or challenge solving; HTTP listener/public service; cloud telemetry; other chat platforms; binary attachment download/indexing; bidirectional sync; deletions mirroring the remote catalog; forced rescan, watcher repair, embedding changes or Miyo/Chrome restart. Do not recreate the retired Obsidian watcher or add AFR/Agent Ledger orchestration to this module.

No hard real-time download promise when the browser, user manager, network, or Miyo is unavailable. No promise of independent ChatGPT quota. Pacing covers **collector-issued HTTP requests**, not network activity automatically generated by loading ChatGPT itself or by other browser tabs/apps. Capture that residual limitation in qualification evidence.

### 2.4 Safety invariants

- I01: no cookie/token/auth-response bytes cross the approved browser execution boundary or enter logs/fixtures/artifacts. Approved background setup and selected-body scopes may use extension-worker memory only; page scopes retain their original page boundary.
- I02: at most one current worker owns writes and request accounting; clients cannot choose alternate accounts or bypass permits.
- I03: incomplete catalog, missing selected bodies, unresolved journal entries or failed verification cannot produce `verified`.
- I04: no custom index dispatch and no custom writes to `files`, `folder_files`, Qdrant, or `chat_sync.json`.
- I05: existing conversation identity, filename and account ownership never change implicitly; absent remote items are retained.
- I06: a durable acknowledgement is emitted only after the promised artifact/state is durable; replay cannot advance counters twice.
- I07: pause stops new dispatch/publication, but does not abandon a publication already past rename or cancel Miyo's indexer.
- I08: production enablement requires explicit authorization and qualified evidence; installation is not successful delivery.

## 3. Architecture, ownership, and bounded implementation discretion

```text
user-level daily timer / CLI / extension popup
                    |
                    v
           durable local worker <---- private Unix socket ---- native host
             |         |                                      ^
             |         +-- local-only verifier                 | Chrome native messaging
             v                                                v
    staged bytes + import journal                  separate MV3 extension
             |                                                |
             v                                      fixed MAIN-world collector
    native Chats + chat_conversations                         |
             |                                      permitted same-origin fetch
             v
      Miyo filesystem watcher -> native index/search
```

This is one worker and one transport adapter, not a general agent platform. Use JS ES modules and built-in Node testing/runtime APIs where adequate. Initial qualified Node target is the observed 22.23.2; declare the supported version explicitly and extend it only with test evidence. `node:sqlite` remains experimental in this release, so isolate it and prohibit extension loading. [S5]

### 3.1 Planned layout

```text
miyo-catchup/
  extension/      manifest.json, background.mjs, page-collector.js, popup files
  src/            cli, coordinator, native-host, protocol, store, collection,
                  publication, verification, configuration and safe-path modules
  adapters/       fingerprinted ChatGPT web contract and Miyo renderer/manifest adapter
  schemas/        protocol-v1.json, config-v1.json, status-v1.json, receipt-v1.json
  tests/          flat *.test.mjs files, fixtures/, browser-qualification instructions
  systemd/        worker.service, request.service, daily.timer templates
  install/        explicit versioned installation/pairing/uninstall helpers
  README.md       commands, compatibility, qualifications, operation and rollback
```

File factoring is advisory; protocol semantics, owner boundaries and acceptance are binding. Do not build a generic workflow engine, schema framework, or migration platform. Machine-readable schemas and their validators must agree under positive/negative fixture tests; a full third-party validation dependency is not preapproved.

### 3.2 Runtime locations and namespace ownership

| Purpose | Target |
|---|---|
| CLI | `~/.local/bin/miyo-chatgpt-catchup` |
| Versioned code | `~/.local/lib/miyo-chatgpt-catchup/releases/<release>/` |
| Explicitly selected release | `~/.local/lib/miyo-chatgpt-catchup/current` |
| Private configuration | `~/.config/miyo-chatgpt-catchup/config.json` |
| New worker-owned persistent namespace | `~/.local/state/miyo-chatgpt-catchup/daily/` |
| Database/artifacts/receipts/backups | Within that new `daily/` namespace only |
| Runtime lock/socket | `$XDG_RUNTIME_DIR/miyo-chatgpt-catchup/` |
| Native host | `local.miyo_chatgpt_catchup`, exact custom extension origin only |

Any pre-existing operator recovery directories outside the new `daily/` namespace remain read-only evidence. Do not migrate, recursively clean, adopt their locks, or overwrite their receipts. Repository bootstrap does not create this runtime namespace. Production paths are pinned at installation; normal IPC does not accept arbitrary path overrides. Isolated tests inject temporary roots without falling back to production paths.

### 3.3 Local trust model and ownership

All local components run as the installing user; private directories are 0700, data/socket files 0600, executables owner-executable, and services use `UMask=0077`. Validate UID/type/link count and each path component; reject group/other-writable ancestors used for private runtime data. Native host registration and source must not be writable by another UID.

Use the installed OS `flock` for process ownership, with a lock descriptor held for the complete coordinator lifetime (including foreground qualification). A second start fails without deleting the socket or acquiring leases. Only the locked owner may remove its own stale socket. Test crash/restart and descriptor inheritance rather than relying on a PID file or `open('wx')` stale lock.

**Explicit correction to v1:** baseline IPC authorization uses Linux filesystem ownership/modes and exact Chrome allowed-origin registration. Do not claim that `node:net` automatically supplies authenticated peer UID or add native/FFI dependencies to obtain it. Same-UID processes, root, the browser, and the genuine ChatGPT page are within the trusted computing base; this is not isolation from a compromised user account or compromised first-party page. Any stronger peer-credential requirement is a separate reviewed design change. [S6]

Only the worker owns durable state and Miyo writes. Native host/CLI forward typed requests. The host validates its Chrome caller-origin argument; no arbitrary commands, SQL, URLs, headers or destinations are accepted. Do not trust a caller-supplied role string as authorization. Registration is not a cryptographic defense against same-UID code.

## 4. Browser collection and native transport contract

### 4.1 Minimum browser surface

Manifest V3; permissions initially `storage`, `alarms`, `nativeMessaging`, `scripting`; host permission exactly `https://chatgpt.com/*`. No `cookies`, `debugger`, `<all_urls>`, externally callable message handler or remote executable code. Use tab creation/management without assuming the broad `tabs` permission is necessary; verify on the qualified Chrome. [S1–S4, S8]

Maintain a single extension-owned inactive top-level ChatGPT tab during collection. Never navigate/close a user-owned tab. Record browser-session, tab and document identity, not just a reusable tab number. If a user navigates the owned tab, it loses capture ownership: stop dispatch and do not close their new document. After restart, uncertain ownership requires reconciliation, not a sweep closing ChatGPT tabs. Close a positively owned capture tab only after work is drained or safely blocked.

### 4.2 Fixed in-page collector

Use packaged fixed functions through `chrome.scripting.executeScript` in the top frame's `MAIN` world, bound to the verified document. The main world is shared with the host page; it is not a sandbox against that page. Validate returned data and never execute response content. [S3]

The collector holds the transient token in a page-local closure, not extension storage or returned values. A separately permitted session request returns only the binding outcome and required principal identifier. Loss of this context requires another permit; no session fetch is hidden inside a body/catalog fetch.

Use a page-local bounded response buffer and fixed pull/release operations so each script result is a small chunk. Stream the response with an enforced byte cap before JSON parsing or complete-string assembly. Do not return the whole response via `executeScript` and then split it. A stable fixed dispatcher/closure is an implementation choice; it may not accept source code or arbitrary endpoint strings from native clients.

Bind to the configured `session.user.id` only after the live proof establishes its mapping to Miyo's `account_id`. Qualify the selected collection/workspace context; principal equality alone does not prove that a workspace switch preserves catalog scope. Default scope is the tested personal/default context. Unknown or changed context blocks capture rather than adding guessed account headers or switching workspaces.

**Approved T02 setup exception:** a separate one-shot `setup-inspection` scope
may begin with an expected principal from a unique nonblank historical Miyo
account and an explicitly unknown (`null`) context. It may obtain exactly one
permitted session response inside the page, compare the expected principal and
record only `{principal_id, context_id}` with the observed account ID. The fixed
inspection adapter requires a personal account, an unambiguous matching page-local
workspace selection and matching token account scope; unknown or changing values
block rather than selecting a workspace. Cookie/token/auth-response bytes never
leave the page. This records candidate setup evidence, not an approved binding or
capture qualification. Selection is rechecked at the page's final handoff before
the native commit. This is point-in-time evidence, not an atomic or ongoing
account binding across browser and native processes. Its private root, durable
scope and terminal state cannot
be promoted into session/body work. A later strictly bound proof needs separate
configuration and a new root; failed or uncertain evidence is never reset.

### 4.3 Wire envelope and operations

Protocol version starts at **1**; plan v2 does not imply wire version 2. Every request has `protocol_version`, UUID `request_id`, allowlisted `operation`, and typed `payload`. Work messages additionally carry worker-issued `run_id`, `attempt_id`, `lease_generation`, and `permit_id`. Replies echo the request ID/version and contain either `{ok:true,result}` or `{ok:false,error:{code,retry_at}}`. Human-facing messages come from local error templates, not raw remote errors.

| Operation | Minimum payload/result semantics |
|---|---|
| `hello` | Extension version, browser-instance ID and capabilities; returns worker instance/protocol/config compatibility, no credentials |
| `request_run` | Trigger type, immutable `publish`/`dry_run` mode, idempotency key; returns run ID, coalescing and blocking state |
| `get_status` | Current status or requested known run; no chat content |
| `claim_work` | Browser identity/context attestation; returns fenced lease and one next logical work unit |
| `request_permit` | Work-unit ID; returns fixed request kind/arguments and short validity deadline, or denial |
| `dispatch_started` | Permit and bound document identity; persisted acknowledgement required before dispatch; uncertain after this point until reconciled |
| `result_chunk` | Permit, zero-based sequence, decoded byte count, base64 bytes; returns next expected sequence; not a durable whole-result acknowledgement |
| `commit_result` | Permit, number of chunks, raw UTF-8 total bytes, SHA-256; returns durable artifact receipt only after validation/fsync/state commit |
| `request_failed` | Permit, allowlisted failure class, HTTP status and bounded Retry-After only; durable/idempotent failure accounting |
| `reconcile_dispatch` | Known permit/document and completion/abort/destroyed-context evidence; cannot clear cooldown or override an identity error |
| `pause` / `resume` | Existing account job control; no force or cooldown override |
| `verify` | Existing run ID; local-only verification, no fetch/repair |

Unknown versions, operations, excess fields, malformed identifiers, wrong run/lease, nonfinite numbers and oversized messages fail closed before side effects. A known request ID reused with identical content returns its previous result; changed content with that ID is rejected. `get_status`/`doctor` are the only paths allowed without an executable compatible job configuration.

Chrome native messages use a native-endian 32-bit byte length followed by UTF-8 JSON. Implement incremental framing for partial/multiple frames and reserve stdout exclusively for frames; sanitized diagnostics use stderr. Chrome starts the host; the worker never tries to initiate native messaging. Native messaging is unavailable directly to content scripts. [S1]

Bootstrap rule: before a principal has been attested, claim_work may grant only a session-check lease for the configured binding. A valid sanitized session outcome upgrades that lease for catalog/body work; a mismatch blocks it. Session transport contains only the sanitized identity/context outcome, never the raw session response or token. This bootstrap path cannot grant catalog access before identity validation.

### 4.4 Application bounds and acknowledgement rules

- Maximum serialized message: **262,144 bytes** including envelope, all legs/directions.
- Raw chunk maximum: **180 KiB** before base64; at most two unacknowledged chunks, with transport backpressure.
- Maximum decoded assembled response: **64 MiB**, enforced while reading; control payloads max **16 KiB**; opaque cursor max **8 KiB**.
- Commit digest covers exact received UTF-8 response bytes, not reserialized JSON. Validate UTF-8, schema, expected IDs and version bounds before accepting it as a successful data result.
- Persist the completed private artifact atomically/fsync, then commit its path/digest and request outcome in worker SQLite, then ACK. After a crash between artifact and DB commit, reconcile the owned artifact; do not increment counters twice.
- Duplicate already-received chunks must match bytes. A gap/out-of-order chunk is rejected with the expected sequence; conflicting replays block that request. Only complete committed artifacts are reusable after restart.
- Interrupted transfer can resend from the still-present page buffer. If the buffer is gone, finish uncertain-dispatch reconciliation before any permitted refetch; do not pretend partial transport was a completed download.
- Clear page buffers/token context when no longer needed. Browser storage may retain bounded sanitized control/failure receipts, never bodies or auth material.

The limits are application policy, not claims that every Chrome leg has the same limit. Chrome documents a 1 MiB host-to-browser native message limit and a 64 MiB browser-to-host limit; these smaller frames leave envelope headroom. [S1]

## 5. Scheduling, lifecycle, and request safety

### 5.1 One queue and explicit coalescing

Use one worker-owned account slot plus one coalesced pending request record. Every daily/CLI/popup request enters the same transactional queue; extension alarms discover work but do not create independent jobs.

| Existing state | New request | Required result |
|---|---|---|
| No active job | Any valid mode | Create one run with immutable mode |
| Active, same mode | Manual or daily | Return active run; record one pending newer catch-up intent only if needed |
| Active publish | Dry-run | Return `mode_conflict`; never relabel the publishing run |
| Active dry-run | Daily/publish | Keep dry-run unchanged; coalesce one pending publish request |
| Active paused/blocked | Any | Return run ID and blocker; do not silently unpause or clear a hard blocker |
| Previous run terminal | Duplicate idempotency key | Return its original receipt; do not perform another run |
| Previous run terminal | New manual key or due daily key | Create next run, subject to account cooldown/budgets/backlog |

Daily idempotency key is `(binding_id, configured timezone, local due date)`. Manual keys are UUIDs. Store the latest coalesced due date and trigger count, not an unbounded history of missed days. A catch-up started after several missed days is one scan, not one scan per day. A pending daily intent already covered by a later-starting scan can be discharged with recorded reasoning; an intent arising after scan start remains at most one subsequent job.

An unresolved publication journal or preceding run's index backlog blocks the next collector, not just the next import. `verify` may continue locally. Explicit `resume` continues the same run/attempt where valid; it does not reset quota counters. Different job modes cannot be merged by a timer.

### 5.2 Services and browser availability

Planned units: `miyo-chatgpt-catchup-worker.service`, `miyo-chatgpt-catchup-request.service`, `miyo-chatgpt-catchup.timer`.

- Worker: long-lived owner with restart backoff/start limits; no upstream calls on its own. It remains active independently of the browser-native-host process.
- Request service: oneshot submits/coalesces a daily request and exits promptly. It orders after/requires the worker and tolerates a bounded startup race; it never runs the browser collector itself.
- Daily timer: proposed `OnCalendar=*-*-* 04:00:00 America/New_York`, `Persistent=true`, `RandomizedDelaySec=10min`, `AccuracySec=1min`. These are explicit defaults awaiting activation approval. No wake-system or lingering changes.
- Browser: one five-minute local discovery alarm; check/create it on each extension service-worker startup and install/update. Alarm events talk only to the local worker when idle. Native connection can remain open during work but should close when idle; no indefinite keepalive loop. Browser shutdown and alarms are not durable job ownership. [S2, S4]
- Closed browser: `waiting_for_browser`; neither systemd nor the native host launches another browser/profile. Browser startup discovers queued work. Restart recovery still reconciles old permits before dispatch.
- User manager unavailable: persistent schedule can be reconsidered when it runs again; exact-time collection is not promised. No system-wide installation or enabling linger implicitly.

These are user services, not ChatGPT scheduled tasks. Native Miyo Capture alarms remain outside this tool's authority; the operator must keep its sync toggle disabled.

### 5.3 Default limits: executable configuration, not informal advice

| Setting | Default | Behavior at boundary |
|---|---|---|
| Active collector requests/account | 1 | Deny further permits until known completion or safe reconciliation |
| Dispatch spacing | At least 5 seconds | Includes session checks and all retries/refetches |
| Session requests/attempt | 5 | `budget_exhausted`; no hidden token refresh |
| Catalog pages/attempt | 300 | Preserve partial scan; never mark complete |
| Body requests/attempt | 200, up to 5 IDs each | Preserve selected/retrieved versions; no batch auto-enlargement |
| Total requests/attempt | 505 | Every issued/uncertain permit consumes budget |
| Request timeout | 30 seconds | Abort where possible; unresolved dispatch is not presumed finished |
| Permit start validity | 5 seconds after grant | Expired unstarted permits cannot execute; count remains conservative |
| Grace after positively drained uncertain context | 60 seconds | Also obey pacing/cooldown; grace alone cannot prove draining |
| Collection active time/attempt | 60 minutes | Checkpoint and require a later eligible attempt |
| Attempts/account/rolling 24 hours | 3 | `budget_exhausted`; no automatic reset on process restart or new run ID |
| Incomplete scan restart age | 6 hours | Restart catalog generation once per run; repeated expiry blocks for review |
| Cooldown minimum on 429 | 1 hour | Honor any longer Retry-After and previously persisted deadline |
| Publication batch | At most 10 files | Verify that batch before publishing the next |
| Index poll / worker heartbeat | 30 seconds each | Hash/vector work is not repeated on every heartbeat |
| Status stale threshold | 90 seconds | Connectivity failure is immediately unavailable; old snapshots labelled stale |
| Index no-progress warning / stop | 30 minutes / 6 hours | Track file/chunk progress; no auto-rescan/restart |
| Newly allocated private artifacts/run | 2 GiB | Count raw, staged, temporary and backup bytes; stop before exceeding |
| All new `daily/` state | 10 GiB | No unverified/prior recovery cleanup to make space |
| Free-space reserve | 2 GiB | Reserve on each involved filesystem before starting the next unit |

Limits are conservative initial policy, not vendor rate-limit guarantees. T02/T09 measure memory, latency and index throughput; changing request ceilings, concurrency or retry behavior requires an explicit reviewed configuration change. Resource limits cannot be bypassed through the popup or arbitrary IPC.

### 5.4 Permit lifecycle, fencing, and uncertain dispatch

Permit states: `granted -> dispatch_started -> result_committed | failed`; `dispatch_uncertain` is a retained blocker on a nonfinal permit. Lease generations are monotonic in durable state. Duplicate messages do not duplicate transitions.

1. Under the worker transaction, check identity, immutable mode, pause, clock health, request/byte budgets, prior dispatch and cooldown. Reserve counters/deadline **before** granting one permit. No speculative permit queue. Reserve the next eligible dispatch no earlier than the permit start deadline plus five seconds; delayed starts must not collapse spacing. The page also enforces expiry and its monotonic inter-dispatch guard.
2. The extension checks bound document identity and permit expiry, sends `dispatch_started`, and waits for durable worker acknowledgement. It then invokes the fixed fetch once; a page-local consumed-permit set prevents duplicate invocation in that context. The page checks expiry again immediately before fetch.
3. Process exactly one terminal result. Response identity/content and hashes must validate before committing it. A received 429/auth failure takes the failure path, not ordinary body staging.
4. After port/host/worker loss, suspension, or missing acknowledgement, fence stale clients for new commits and reconcile the previously started permit. Do not infer that a request ended from lease expiry, browser timer expiry, or a worker restart.
5. Reconciliation requires an acknowledged settled/aborted fetch from the original context or confirmation that its positively identified owned document/browser session no longer exists. If the worker cannot establish that, retain `dispatch_uncertain` for operator action. Do not close unproven/user-owned tabs to force recovery.
6. Once drained, wait the configured grace plus remaining pacing/cooldown and resume under the current generation. Already committed results are reusable; stale uncommitted results cannot authorize publication.

The guarantee is **one controlled outstanding client request and idempotent durable acceptance**, not exactly-once execution inside the remote server. Browser/network ambiguity can produce an unknown remote outcome; these requests are read-only. Do not advertise server-side exactly-once semantics.

Use monotonic elapsed time within a boot and persisted wall deadlines across restarts. Persist last observed wall time and boot/clock context. A detected material wall-clock discontinuity (default discrepancy over 60 seconds versus monotonic elapsed), or uncertain clock continuity across reboot while cooldown is active, sets `clock_untrusted`; do not shorten deadlines. Reestablish trusted time conservatively before dispatch. Tests use injected wall and monotonic clocks, including suspend, backward/forward jumps and reboot.

### 5.5 Failure and retry decisions

| Event | Immediate effect | How progress may resume |
|---|---|---|
| 429 | Stop dispatch; durably set cooldown to max(previous, observed-at + 1 hour, Retry-After deadline) | A later daily/manual/resume trigger after cooldown, with other gates satisfied |
| Retry-After integer seconds | Add nonnegative seconds to observed-at; reject overflow | Never clamp a valid long wait downward |
| Retry-After HTTP date | Parse finite UTC deadline; a past date cannot defeat the one-hour floor | Same as above |
| Missing/invalid Retry-After | Apply one-hour floor; record sanitized reason | Same as above |
| 401/missing login | `login_required`; no repeated auth probes | Operator logs in normally, then explicit resume |
| 403, challenge HTML or security prompt | `challenge_required` unless a qualified classifier distinguishes it | Operator action; no challenge solving or evasion |
| Principal/context mismatch | `account_mismatch` | Explicit reconfiguration review; never repurpose existing manifest rows |
| Unsupported response/build/schema | `schema_changed` / `unsupported_version` | Qualified adapter update; never guess new fields or endpoints |
| Network/5xx/timeout | End attempt and checkpoint; drain uncertain work | Later eligible daily/manual attempt, not five-minute alarm retries |
| Invalid/repeated cursor, missing IDs, older body | Block with specific catalog/body error | No silent skip; inspect or a bounded new qualified scan |
| File/row conflict or unsafe path | Stop new publication | Operator resolves conflict; no force overwrite or full restore |
| Index error/stall | Stop next publication/collector; keep evidence | Local verify/review only; no upstream retry or automatic Miyo repair |
| Disk/state corruption | Stop before next irreversible unit | Explicit local recovery with evidence preserved |

If the extension observes a failure before the worker can durably acknowledge it, persist a sanitized pending failure receipt in local extension storage and replay it first on reconnect. No token, response body or raw exception text is stored. An unacknowledged dispatch remains uncertain even if this secondary receipt is lost; restart cannot silently forgive a possible 429.

`pause` persists intent first. It prevents new permits and new publication units; an in-flight response may be saved. Finish or journal an already-renamed file to the safe recovery boundary. Miyo indexing and read-only verification may continue. The reply distinguishes `pause_requested` from `paused_at_safe_boundary`. Resume does not clear cooldown, schema/identity errors, conflicts or an unresolved dispatch.

## 6. Catalog, version selection, and rendering semantics

### 6.1 Qualified web adapter

The historical observed route is session `GET /api/auth/session`, cursor catalog `GET /backend-api/conversations/search?query=&cursor=<opaque>`, and body `POST /backend-api/conversations/batch` with `{conversation_ids:[...]}`. The separately approved T02 background proof instead uses the installed reference's fixed single-conversation `GET /backend-api/conversation/<id>`; it does not qualify the historical catalog/batch routes. These are private web endpoints, not a public supported API. Freeze the tested contract and fixture fingerprint at T02; no runtime-supplied endpoints or caller-controlled headers. [L4, L6]

Required catalog fields: `items` array, per-item nonempty `conversation_id` and finite `update_time`, and a cursor following the qualified terminal convention. Preserve opaque cursors exactly; never parse them as offsets. A **null or empty terminal cursor** is completion only after explicit catalog qualification in T04; the selected-body-only T02 proof does not confirm that shape. Absent/unexpected cursor fields fail schema validation. An empty page with a valid nonterminal cursor continues; an empty page is not independently an end signal. Repeated previously visited nonterminal cursors stop with `catalog_cycle`.

Commit each page and next cursor together through the result receipt. Deduplicate IDs, retaining the maximum observed normalized timestamp. Do not stop at an old timestamp, unchanged page, locally known conversation or a reported total. A moving catalog can omit concurrent changes; later runs reconcile them. Receipt records scan start/end, page/unique-item counts and `coverage=qualified_catalog_only`.

### 6.2 Partial runs and snapshot generation

A full catalog checkpoint is published only after validated terminal enumeration. Within six hours, resume an incomplete scan from its last durably committed cursor. On expired/invalid cursor or a longer gap, a later allowed attempt may restart enumeration once with a new `catalog_generation`; partial earlier pages do not become evidence of full coverage. Retain them for diagnosis. A second required restart blocks `catalog_unstable` instead of looping.

Completed scans are immutable evidence of their observation interval. A slow local indexing phase does not retroactively turn that scan into a present-time snapshot. A subsequent publishing run reusing dry-run/raw cache must perform a fresh complete catalog and revalidate identity, adapter fingerprints, base rows/files and selected versions.

### 6.3 Selection contract

Normalize remote timestamps as `floor(seconds * 1000)` and stored ISO timestamps as exact parsed integer milliseconds; reject nonfinite, invalid or unsafe-range values. A selected target version is the maximum relevant catalog/previously committed version. A body predating it is rejected, not imported with a one-millisecond ad hoc tolerance.

| Local condition | Catalog observation | Action |
|---|---|---|
| No manifest row/file at canonical target | Remote item | Select `new` |
| Same bound row; file exists | Remote timestamp newer | Select `updated` |
| Same bound row; file missing | Remote item | Select `missing_body`, but never lower the stored version |
| Same bound row; known committed digest or metadata baseline consistent | Remote timestamp not newer | Count `unchanged`; no body request, no file rewrite |
| Known owned digest changed locally | Any | `local_conflict`, not silent recapture |
| Existing `(platform, conversation_id)` belongs to another/blank account | Any | `account_mismatch`; no reassignment or merge |
| Local row absent from catalog | None | Preserve it; report outside this scan's exposed set |

Timestamp-based incrementality assumes the endpoint advances `update_time` for content changes. It cannot detect an upstream same-timestamp edit; disclose this limitation. Do not silently add a recurring full-body audit to compensate.

Bootstrap reads current manifest/files as a **local metadata baseline**, not a proof of remote completeness. Record provenance `baseline_unverified` unless supported by exact current receipts. Existing recovery evidence may be adopted only after revalidation; never copy its completed flags. Unchanged baseline entries do not become newly verified corpus entries merely because they were listed again.

### 6.4 Body and content checks

One body request contains at most five selected IDs. The returned set must match exactly: no omission, duplication, extra ID or cross-account/context change. Require the qualified mapping/current-node shape and a sufficient version. Deletion/permission changes after listing or zero importable content block that item; they are not silently counted as success. A future explicitly specified tombstone/empty-chat policy would be a separate change.

Persist raw data privately before rendering. Preserve qualified branch traversal, roles, deep-research text, timestamps, frontmatter, attachment references and existing local attachment links; do not fetch attachment binaries. Use deterministic rendering from the qualified adapter. Same input/version/adapter must produce identical bytes irrespective of wall time, run ID, locale or process restart.

Keep existing filename and project assignment even if title/project changes remotely. New chats use the qualified date/title/ID naming function and a known safe project mapping. Unknown projects receive an ID-derived safe relative directory; default chats stay in the native root. Do not update `chat_sync.json` to create mappings. Validate Unicode, byte-length limits and collisions; never silently overwrite or truncate content/names into a collision.

Identical rendered bytes produce `byte_noop`: preserve file/inode/mtime and existing indexing generation. Update only necessary same-owner manifest fields through the journal/CAS rule and worker provenance. Record timestamp-only/metadata-only changes separately from new-message claims.

## 7. Durable state, statuses, and compatibility

### 7.1 Minimum logical records

Use one private SQLite DB owned by the worker; no second state coordinator. Use explicit transactions, bound parameters, foreign keys and durable synchronous commits. Qualify crash recovery on the actual filesystem. Worker WAL settings may be chosen/tested for its own DB; do not change live Miyo PRAGMAs/journal mode or run its migrations.

| Record | Required identity and content |
|---|---|
| `binding` / configuration | One active principal/context; pinned roots, versions/fingerprints and config version |
| `jobs` | Run UUID, immutable mode, trigger/coalescing, stage, blockers, pause flag, current attempt and terminal receipt |
| `account_gate` | Cooldown, next dispatch, attempt history, last wall/boot observation, active permit and lease generation |
| `attempts` | Attempt UUID, run, counters, accumulated active time, catalog generation/start/end and stop reason |
| `requests` | Unique permit/request IDs, logical work ID, bound generation/document, arguments digest, dispatch and outcome |
| `catalog_items` / page receipts | `(run, generation, conversation ID)` newest observed timestamp; page artifact/cursor chain |
| `artifacts` / selected items | Owned path, digest/size, identity/version, renderer fingerprint and stage |
| `publication_journal` | Unique `(run, conversation, target version/digest)` intent, old/new row/file fingerprints, durable backup/stage refs and recovery status |
| `verification_receipts` | Exact file version/generation, manifest/index/vector/search evidence, checked-at and compatibility fingerprint |

Names/table splitting are advisory; uniqueness and transactional semantics are binding. Keep bulky content out of SQLite where a private artifact reference suffices. Never add credentials, raw authentication responses, arbitrary SQL, or executable page content.

Unknown worker-state version: open read-only for diagnosis and block work. Initial installation creates schema version 1 only in the new namespace. Later migrations require a worker-stopped SQLite backup using a safe backup mechanism (not copying only a live WAL main file), tested upgrade/recovery and explicit rollback compatibility. A previous binary cannot open a newer schema for writes by guesswork.

### 7.2 State transitions

```text
queued -> catalog -> downloading -> staged -> importing -> indexing
                                                  ^          |
                                                  +----------+  next batch, only after batch verification
                                                             |
                                                             v
                                                       final_verification -> verified
staged -> dry_run_complete   (dry_run only; no live mutation)
```

Persist a separate blocker set, primary blocker, `pause_requested`, cooldown and resume stage. Do not overwrite a cooldown merely to display `paused`. Identity/schema/path/conflict errors outrank ordinary waiting in the primary display. A no-change complete scan may pass directly to final verification and terminate `verified` with `completion_kind=no_changes`.

Per selected item: selected -> downloaded -> staged -> publication-prepared -> imported -> index-metadata-current -> verified. `byte_noop` follows the applicable manifest/current-generation verification path without physical publication. Crash recovery may re-enter a prior execution stage; durable counts are recomputed from unique records, not incremented from replayed messages.

For stage-order invariants, downloaded means a validated durable body is available, including explicitly qualified reused artifacts; additionally report bodies fetched in this attempt and bodies reused separately.

Counters distinguish: catalog unique, selected new/updated/missing-body, downloaded bodies, staged items, physical files published, metadata rows changed, byte no-ops, indexed-metadata-current, verified selected versions, unchanged catalog items and blocked items. Invariants include `published <= staged <= downloaded <= selected` and `verified_selected <= selected`; physical publication and verified-version counts need not be equal.

### 7.3 CLI/status contract

```text
miyo-chatgpt-catchup run [--dry-run] [--json]
miyo-chatgpt-catchup status [--json]
miyo-chatgpt-catchup pause
miyo-chatgpt-catchup resume
miyo-chatgpt-catchup verify [--run RUN_ID] [--json]
miyo-chatgpt-catchup doctor [--json]
```

`run` returns acceptance/coalescing and run ID, never an indexing-completion claim. Dry-run may read upstream and store private staged data under all limits, but cannot open the Miyo manifest for writes or publish files. Mode is immutable. `verify` is local-only and may update this worker's own receipts, never the historical recovery receipts or Miyo's index. `doctor` performs read-only checks without creating a job, pairing, repair or upstream request.

CLI exit codes: 0 command accepted/read succeeded; 2 invalid input/config; 3 worker unavailable; 4 request rejected by blocker/mode/authority; 5 local internal/validation failure. A `status` response reporting a blocked job is still a successful read (0). JSON contains the job status; scripts must not interpret exit 0 from `run` as task completion.

Status-v1 contains: `generated_at`, connectivity/liveness, worker instance/version, run/mode/trigger/attempt, stage/resume stage, blockers/primary blocker, pause state, scan interval/generation/coverage, counts, last complete scan, last fully verified run, receipt evidence timestamp, next scheduled due time, cooldown/retry deadline, budget remaining and sanitized actionable error code. Unknown schedule is null; do not invent a next time when the timer is disabled.

`status` checks the live socket; a cached JSON file cannot prove liveness. Heartbeats every 30 seconds; disconnected means unavailable immediately, and snapshots older than 90 seconds are stale. Do not call the last successful capture stale just because the service is offline: label historical success and current connectivity separately. Popup renders strings with text APIs, never unsanitized HTML.

## 8. Native Miyo compatibility and recoverable publication

### 8.1 Adapter qualification before live mutation

Discover the actual running bundle, native ChatGPT folder, manifest and local service rather than copying a transient `/tmp/.mount_*` path. Record Miyo version plus bundle SHA-256, relevant schema fingerprints, renderer extraction boundaries and adapter version. An apparent version match without matching qualified interfaces is insufficient. Unknown compatibility blocks publication. [L4, L5]

The adapter owns five narrow capabilities: normalize a qualified body, render deterministic native Markdown, validate/derive a relative filename, compare/update a conversation row, and read qualified indexing evidence. Keep these separate from scheduling and protocol handling. Prefer supported interfaces where proven; the currently observed manifest adapter is not a vendor-supported import API.

If extracting installed renderer functions, validate exact bundle hash and extraction markers and execute only trusted installed code. `node:vm` is not a security boundary for untrusted code. Never evaluate downloaded conversation content or vendor third-party source without checking its license. Fixtures cover branches, deep research, frontmatter escaping, native dates and existing attachment links.

Observed `chat_conversations` fields are `platform`, `conversation_id`, `filename`, `title`, `url`, `updated_at`, `synced_at`, `account_id`, and `project_id`; the primary key is **`(platform, conversation_id)`**. The importer must query that actual key and independently compare account ownership. Do not implement a nonexistent three-column conflict target. Blank/foreign account ownership requires review, not automatic reassignment.

Before collection, before each publication unit and at final verification, confirm the native ChatGPT accounts array is empty and the registered folder is unchanged. If sync reconnects externally, stop new work and report it; never disconnect that actor silently. Miyo may change index tables through its normal watcher, but no other importer may write the selected conversation rows/files during publication.

### 8.2 Publication transaction boundary

A worker DB transaction, file rename and Miyo DB commit cannot form one atomic transaction. Use a per-item journal and explicit recovery instead. Complete expensive rendering, hashing and backups before taking a live manifest write lock.

1. Validate selected identity/version, compatible adapter, safe canonical path, sufficient space, current expected row and old file digest. For a new chat, assert no row exists under the actual key and no file occupies the target. Existing row/file metadata must match the captured baseline.
2. Durably store the staged bytes, original row and original file backup, plus a `prepared` journal entry with old/new digests, exact intended row, relative target path, adapter fingerprint and run identity. An absent old file/row is an explicit value, not an empty file.
3. Open a same-directory temporary file exclusively with restrictive permissions and no symlink following. Write and fsync the complete bytes. Validate all ancestors, file type, owner and link count; reject traversal, NULs, directory targets, collisions and hard links. Do not expose temporary files with a watched Markdown suffix.
4. Begin a short `BEGIN IMMEDIATE` transaction on the Miyo manifest with a five-second busy timeout. Re-read the actual keyed row and compare all expected ownership/version fields. Immediately recheck the target file identity/digest. A mismatch aborts before rename.
5. For changed bytes, publish by atomic same-directory rename and fsync the parent directory. Ensure the observed integer-millisecond mtime is distinguishable from the prior indexed generation; delay/recheck rather than silently inventing a distant future timestamp. Store the exact observed mtime in the journal evidence.
6. Within that same short manifest transaction, perform a same-owner insert/update conditioned on the expected row and assert the affected-row count. Update only this conversation's qualified columns. Commit. No network/index wait or whole-batch transaction may hold this lock.
7. Commit the worker journal's imported receipt, including actual file digest/mtime and new row fingerprint. Then release this item to watcher verification. A lost acknowledgement does not replay an already completed publication.

A byte-noop skips temporary file replacement and preserves inode/mtime. Any necessary metadata-only update still uses expected-row comparison and a durable journal; an unchanged row gets no gratuitous `synced_at` rewrite. Import statistics distinguish physical publication from metadata changes.

Filesystem rename is **not** an atomic compare-and-swap against arbitrary external editors. The operating contract is that these native-managed files are not concurrently edited by another writer during the publication critical section. Backups and last-moment comparisons detect observed conflicts; they do not justify an absolute claim of protection against an uncooperative same-UID writer racing the rename. If exclusive operational ownership cannot be established, block live activation and revisit the publication mechanism instead of making a false safety guarantee.

### 8.3 Recovery matrix and pause behavior

Recovery first acquires worker ownership, rechecks compatibility/native sync and inspects actual row/file state. Compare against the durable prepared journal, never against a cached progress count.

| File state | Manifest state | Recovery action |
|---|---|---|
| Expected old/absent | Expected old/absent | Resume this prepared item after preflight; no mutation has been established |
| Expected new | Expected old/absent | Verify new bytes and ownership; finish the guarded manifest update without rewriting the file |
| Expected new | Expected new | Finalize the worker receipt and proceed to verification; do not republish |
| Expected old | Expected new | Contradiction: block for operator review; do not guess which state is authoritative |
| Unexpected bytes/path/owner | Any | `local_conflict`; retain backup, staged result and journal |
| Any | Foreign or unexpected row | `local_conflict`/`account_mismatch`; never overwrite the newer actor |
| Corrupt/missing required evidence | Any incomplete state | `recovery_evidence_missing`; stop safely |

For metadata-only items, old and new file digests may be equal; the row fingerprint and journal transition distinguish completion. Idempotency keys and affected-row assertions prevent duplicate rows and repeated counting.

A pause or graceful stop before rename can leave the prepared item untouched. After rename, finish the safe journal/manifest reconciliation boundary when possible; on error, retain the explicit incomplete state. Do not hide a pending publication under a generic paused message. A crash or forced termination may still interrupt any step, so fault tests remain mandatory.

Only Miyo's filesystem watcher dispatches indexing. Do not call `POST /v0/file`, rescan/repair endpoints, update `files`/`folder_files`, register a replacement folder, or mutate Qdrant. Do not restore a whole live database to resolve one item's conflict. The original recovery backups/receipts remain unchanged.

## 9. Verification contract and parent-level completion

### 9.1 Per selected version

Each imported or metadata-updated selected version needs evidence tied to its run, exact file and compatible adapter:

1. Canonical file SHA-256 matches intended rendered bytes; exact required manifest fields and account ownership match.
2. Native indexed file size and integer-ms mtime match the physical file; nonempty rendered content has a positive expected chunk count.
3. Read-only exact Qdrant counting for that file/current generation equals the expected count. Also count all indexed generations for that file and reject unexpected stale-generation points. A green current-generation count alone does not rule out stale replacement vectors.
4. Where the qualified index exposes chunk identities/generation fields, validate their expected set rather than treating an aggregate count as proof of unique correct content. Fingerprint these semantics in the adapter.
5. Revalidate file hash/manifest after expensive checks so concurrent changes cannot invalidate the evidence silently.

Use only pinned local query interfaces. An HTTP POST used by the existing vector-store count/search API is a read query, not permission for writes. Unknown payload schema/collection semantics block verification; no repair follows automatically.

### 9.2 Retrieval and combined acceptance

Qualification must retrieve **one newly imported canary and one updated existing canary through native Chats search**, scoped to their exact paths. The updated canary must be retrieved using text demonstrably added in the selected version, not text that was already present. Record private query/result evidence without copying chat content into source or public logs.

Every nonempty production run additionally performs at least one selected-version retrieval smoke check, using newly changed text for an updated item where available; if no updated item exists, use a new item. This is retrieval sampling plus exhaustive selected-version hash/manifest/vector verification, not exhaustive semantic search testing of every message. A no-change run does not fabricate a new-content canary.

A publishing run is `verified` only when the catalog completed, every selected version passed its applicable checks, all publication journals are resolved, required retrieval checks passed, native sync remains disconnected, and there are no unresolved run blockers. An unchanged full scan can complete as `verified/no_changes`; its receipt explicitly states that unchanged baseline chats were not all reindexed/reverified. Dry-run terminates only as `dry_run_complete`.

Keep separate timestamps for last complete catalog, last fully verified selected set and the receipt's observation time. Label the freshness boundary by scan interval and scope. Never promote the last verified time because downloads completed, an import receipt exists, the folder says ready, or a daily timer fired.

The final **parent-level** proof is the real extension -> native host -> worker -> native Markdown/manifest -> watcher/index -> native Chats search path, followed by an unchanged repeat with zero body downloads, zero physical rewrites and no duplicate metadata. Passing isolated component tests does not substitute for this combined result.

### 9.3 Progress and backpressure

Publish at most ten items, then wait for that batch's selected-version verification before publishing the next. Before admitting a new collector, resolve the previous run's pending publication/indexing work. A no-change catalog alone must not clear a pre-existing indexing failure.

Poll local progress every 30 seconds and detect actual file/chunk-level advancement; heartbeat movement does not count as index progress. Warn after 30 minutes without progress; after six hours unresolved for a batch, retain `index_stalled` for review. Record unavailable progress instrumentation explicitly. Do not relabel a slow large conversation as failed solely because completed-file count has not changed.

Perform hashes/vector counts when an item becomes a completion candidate and at final verification, not on every heartbeat. Keep independent verification active after the Chrome tab, native host, popup and initiating agent terminate. Report unrelated folder errors separately unless they invalidate shared indexing health; do not turn this collector into a whole-corpus repair job.

## 10. Implementation task graph and bounded handoffs

Use these outcome-sized tasks, not one task per file. Core path:

```text
T01 -> T02 (standalone browser proof) -> T03 -> T04
                                  T03 -> T05 -> T06
                                    T04 + T06 -> T07 -> T08 -> T09 -> T10
```

Offline adapter fixtures can be explored after T01, but do not complete a large scheduler/import stack before T02 settles browser feasibility. T02 may use a minimal protocol-compatible staging worker; T03 turns it into the durable coordinator. Fresh findings change advisory factoring, not binding behavior without review.

### T01 — Baseline, contracts, and isolated test harness

**Authority/dependency:** A1; first task. **Implements:** R02, R11, R12, R15, R16.

Refresh host/root/guidance/Git state and compatibility evidence. Define the v1 schemas, fixed config defaults, result validators, fake clocks/network and temporary-root test harness. Qualify Node SQLite transactions, crash/backup behavior, `flock` lifetime, UTF-8 framing and safe paths. Capture initiative tracking only if current repository guidance requires it at implementation time; do not add a new tracking system.

**Exit:** AC02, AC12, AC13 schema-level cases pass with no upstream requests/live writes; unsupported versions fail closed. Return owned files, actual test commands/results and compatibility gaps. No installation or schema change to Miyo.

### T02 — Smallest standalone browser-to-local proof

**Authority/dependency:** A2 after T01; one explicitly selected conversation. **Implements:** R01, R02, R14, R15.

Package the minimum-permission extension, exact-ID native host and private staging receiver. Prove a separately permitted session check followed by one body fetch through the existing signed-in browser profile, without Codex/CDP, cookies permission/export or native sync. The approved background amendments above supersede the original in-page/owned-tab requirement for this proof: use the pinned personal-account token, a cookie-free body GET and a distinct collector instance, with no owned tab created or visible-workspace attestation. Verify byte-exact chunk transfer, identity/context mapping and token non-export. Exercise a synthetic large response and lost port without publishing chats.

**Exit:** AC01, AC02, AC06 and AC13 scoped bridge cases pass, exact digest received, no secret traffic/logs. Record tested session/body evidence and the amended no-owned-tab lifecycle. T02 uses a dedicated qualification harness pinned to the approved conversation ID and reports `background_probe_complete` for the approved background scope (`probe_complete` remains the page-scope result), never a completed catalog run. Catalog-fixture derivation and terminal-cursor qualification are explicitly unperformed by this selected-only proof and remain required T04 work, not waived acceptance. Live full-catalog behavior is qualified in T04/T09 under sufficient read authorization. If extra permissions, different auth or another browser profile are required, stop here and amend the architecture before broader implementation.

### T03 — Durable coordinator, permits, and lifecycle

**Authority/dependency:** A1 after T02 proves feasibility. **Implements:** R05, R06, R09, R10, R11, R13.

Implement the worker DB, single-owner lock, IPC, immutable job modes, coalescing, fences, permit reconciliation, cooldown/clock rules and CLI controls. Persist enough failure evidence to survive browser/native-host/worker crashes without clearing rate policy. No Miyo publication yet.

**Exit:** AC05, AC06, AC10, AC11 and AC14 fixture suites pass, including competing clients, uncertain dispatch, paused jobs and restart. A disconnected process cannot be portrayed as live.

### T04 — Full catalog and delta-to-staging slice

**Authority/dependency:** A1 after T03; any larger live read requires A2 scope covering that read, not merely the one-body proof. **Implements:** R03, R04, R05, R13.

Implement complete pagination, deduplication, partial-scan recovery, bounded attempts, exact body selection/validation, private staging and no-change behavior. Integrate the proven extension path. Use synthetic unordered/moving catalogs first; no live file publication.

**Exit:** AC03, AC04, AC05, AC13 and AC14 pass. An unchanged replay requests only required session/catalog data, not bodies; incomplete or malformed coverage never becomes verified.

### T05 — Native adapter and publication journal

**Authority/dependency:** A1 after T03; read-only installed compatibility inspection allowed, live mutation still requires A3. **Implements:** R06, R07, R11, R12.

Qualify native normalization/rendering and actual manifest primary-key/account semantics against synthetic fixtures and isolated DB/files. Implement backups, prepared journal, guarded publication, metadata-only path, recovery matrix and explicit writer assumptions. No calls to the native file/import endpoint or vector mutation APIs.

**Exit:** AC07, AC08 and AC12 pass at every fault boundary, including rename-before-DB-commit and commit-before-receipt. Zero cross-account reassignment, duplicate rows, unsafe overwrites or original-recovery changes.

### T06 — Exact verification and honest status

**Authority/dependency:** A1 after T05. **Implements:** R08, R09, R10, R16.

Implement per-version hash/manifest/index/vector checks, retrieval qualification interfaces, batch backpressure, independent local verification, blockers and popup/CLI status. Use injected false-green metadata, stale/mixed vectors and dead-heartbeat cases.

**Exit:** AC09 and AC10 pass; fake folder-ready/count success cannot satisfy conformance. Verification does not fetch from ChatGPT, repair Miyo, or alter historical recovery receipts.

### T07 — Approved new/updated native canaries

**Authority/dependency:** A3 after T04 and T06; exact selected new/updated canaries approved. **Implements:** R01, R06, R07, R08, R14.

Recheck live versions, native sync, current recovery backlog and absence of competing writers. Reverify earlier recovery with read-only checks/new private receipts, not blind execution of its old receipt-writing helpers. Back up the selected canaries, publish via watcher only, and retrieve their new/changed text from native Chats. Stop before wider import on any mismatch.

**Exit:** AC01, AC07, AC08, AC09 and the canary portion of AC16 have live evidence. Both new and updated canaries pass, existing recovery remains intact, and no second indexing owner was introduced.

### T08 — Versioned installation and supervised services

**Authority/dependency:** A4 after T07. **Implements:** R09, R10, R11, R12.

Install versioned code/configuration and stable explicit extension pairing, leaving the daily timer disabled. Package the worker/request/timer units and exact unregister/rollback behavior. Update this repository's `AGENTS.md`, `README.md` and operational documentation together. Keep any operator-repository pointer accurate without moving private evidence into this repository; preserve unrelated changes.

**Exit:** AC10, AC11 and AC15 pass in controlled service operation: worker/verifier survive initiating terminal exit, browser-closed jobs wait, and the old log-maintenance/native-host registrations remain untouched.

### T09 — Complete on-demand run, repeat, and release qualification

**Authority/dependency:** A3 plus A4 after T08; operator-approved full-run scope. **Implements:** R01–R16.

Execute one complete on-demand capture through verification, then an unchanged controlled repeat. Compare semantic requirements to exact implementation/fixtures and inspect secrets/permissions. Run crash/rate-limit fault tests only in controlled fixtures; do not cause a production 429 deliberately. Measure actual state growth, memory/backpressure, pacing and index latency against configured limits.

**Exit:** All AC01–AC16 are accounted for with pass evidence at the appropriate layer; parent end-to-end proof passes. Record any genuine upstream changes between live scans instead of claiming a live repeat was unchanged when it was not; use frozen inputs for deterministic no-op proof.

### T10 — Explicit daily activation and handoff

**Authority/dependency:** A5 after T09. **Implements:** R10, R12, R14, R16.

Confirm schedule/timezone/jitter and availability policy, then enable only this timer. Observe the first real scheduled job through final verification and record installed release/unit state and next due time. A simulated timer start or queued job is not that evidence.

**Exit:** First scheduled run verified, rollback/status commands delivered, limitations disclosed. If the scheduled observation has not occurred yet, mark activation pending qualification rather than claiming completion or promising unattended background work from a chat session.

## 11. Acceptance matrix and test oracles

Use requirement IDs in tests/receipts where useful. The following ACs are binding; filenames are proposed flat test-family names. Synthetic tests must not fall back to real browser credentials, production paths or live network endpoints. Use explicit injected roots, clocks, fetch transports and fake local index responses. Tests that require Chrome or live Miyo run separately under the relevant authorization.

| AC | Requirements | Scenario and objective pass condition | Test/evidence owner |
|---|---|---|---|
| AC01 | R01, R02, R14 | Separate extension fetches one approved body with native sync off; credential sentinels never cross the approved browser execution boundary (page for page scopes, short-lived worker memory for approved background scopes); forbidden native sync/import endpoints are unreachable from custom paths | `browser-contract.test.mjs`; background collector/integration tests; T02/T07 live receipts |
| AC02 | R02, R07, R11 | Wrong principal, changed collection context, unknown protocol, blank/foreign manifest account all block before catalog/publication; existing row remains byte-for-byte logically unchanged | `identity.test.mjs`; T01/T02/T05 |
| AC03 | R03, R11 | Unordered/duplicate pages retain the newest version; empty nonterminal page continues; cycle/malformed/expired cursor and partial scan cannot produce a complete checkpoint; bounded restart does not mix generations | `catalog.test.mjs`; T04 |
| AC04 | R04, R07 | Frozen unchanged repeat makes zero body requests and preserves every live file's bytes/inode/mtime; missing-body recovery never downgrades a newer local version; absent remote rows are kept | `selection.test.mjs`; T04/T09 |
| AC05 | R05, R11 | Fake-clock dispatches including session checks respect spacing/caps; seconds/date/malformed 429 Retry-After obey longest deadline through restart; clock jumps and uncertain reboot cannot shorten cooldown | `pacing.test.mjs`; T03 |
| AC06 | R05, R06 | Two clients cannot own concurrent permits; expired/stale leases cannot commit; kill/lost ACK/replayed chunks do not double-count; an undrained browser context blocks new dispatch | `protocol.test.mjs`, `lifecycle.test.mjs`; T02/T03 |
| AC07 | R06, R07, R12 | Fault before/after prepare, rename, manifest commit and receipt converges only through the recovery matrix; foreign edits, SQLITE_BUSY and disk-full preserve evidence; no duplicate row/file or whole-database restore | `publication.test.mjs`; T05/T07 |
| AC08 | R07, R11 | Branch/deep-research/Unicode/frontmatter/project/attachment fixtures match qualified native rendering; existing names/projects preserved; changed bundle/schema and filename collision fail closed | `adapter.test.mjs`; T05 |
| AC09 | R08 | False-ready metadata, wrong hash/mtime, missing/duplicate/stale-generation vectors and old-text-only retrieval do not pass; new and updated canaries have current native Chats results | `verification.test.mjs`; T06/T07 |
| AC10 | R09, R10 | Dead socket plus old heartbeat is unavailable/stale, never live; pause and cooldown remain simultaneously visible; imported-but-indexing-pending is not done; verifier survives initiating-client termination | `status.test.mjs`; T06/T08 |
| AC11 | R05, R10 | Simultaneous timer/manual requests coalesce; browser-closed/missed days defer one job; DST fall-back duplicate local due date does not create two runs; startup recreates missing alarm without upstream idle polling | `schedule.test.mjs`; T03/T08 |
| AC12 | R02, R11, R12, R15 | Traversal, symlink/hardlink, wrong owner, unsafe ancestor, hostile title/SQL-like content and log/error sentinels are rejected or treated strictly as data; no private chat material enters repo fixtures/journal | `safety.test.mjs`; T01/T05/T09 |
| AC13 | R05, R11 | Split multibyte UTF-8 frames and large synthetic payloads round-trip with exact digest; oversized frames/bodies/artifacts fail before exceeding caps; memory/pending-byte growth is bounded on every transport leg | `bounds.test.mjs`; T01/T02/T04 |
| AC14 | R13 | Dry-run cannot open live manifest for writes, publish files, become publish through coalescing or advance last verified time; cached dry data needs a fresh qualifying scan before later publication | `dry-run.test.mjs`; T03/T04 |
| AC15 | R10, R12 | Installation/rollback changes only owned release/unit/host paths; unknown state downgrade refuses writes; stopping/uninstalling preserves imported chats, old recovery, Miyo Capture and log maintenance | `installation.test.mjs`; T08 |
| AC16 | R01–R16 | Real end-to-end new/updated capture passes all selected-version evidence; controlled repeat is a no-op; exact plan/code/config/adapter versions and validation results are recorded; first scheduled verification is separately demonstrated | T09 parent receipt; T10 scheduled receipt |

Tests must assert prohibited side effects, not only returned status codes. For example, a rejected foreign-account row must be unchanged, and a rejected oversized response must not already have allocated/written beyond its cap. Test failures caused by a design contradiction require correcting the implementation or an approved plan amendment, not changing the assertion to match current behavior.

### Planned validation commands

These commands describe the future tool, not tests already run while authoring this plan:

```bash
# From the standalone repository root after functional tests are implemented:
node --test tests/*.test.mjs

# Validate rendered, concrete unit files in an isolated qualification directory:
systemd-analyze --user verify QUALIFICATION_DIR/*.service QUALIFICATION_DIR/*.timer
systemd-analyze calendar '*-*-* 04:00:00 America/New_York'

# After authorized installation; these are local checks, not upstream capture:
miyo-chatgpt-catchup doctor --json
miyo-chatgpt-catchup status --json
miyo-chatgpt-catchup verify --run RUN_ID --json
```

Use an actual existing qualification directory and run ID; never paste placeholders literally. Unit verification must include real ExecStart paths/dependencies without enabling units. A built-in test runner success is necessary but not sufficient for Chrome permissions/authentication, native watcher integration, or scheduled delivery.

## 12. Installation, retention, rollback, and readiness decisions

### 12.1 Explicit installation and operational qualification

Pin an extension identity before live pairing. Use the documented manifest public `key` mechanism where appropriate; never commit its private signing material. Native-host `allowed_origins` contains exactly that extension origin. Register only the custom host in the actual browser's user-specific native-host directory, not by guessing a profile-number subdirectory or replacing `md.miyo.chatsync`. [S1, S7]

Install into a new versioned release directory; validate it before atomically selecting `current`. Keep the preceding known-good release. Update/reload an unpacked extension explicitly; no remote self-update code. A worker/extension protocol mismatch blocks new jobs. Source release selection may use an installer-owned validated symlink; untrusted artifact/data symlinks remain prohibited.

Configuration schema v1 includes the principal/context binding, pinned native roots, release/adapter fingerprints, timezone/schedule, every limit in section 5.3 and private-state ownership. Unknown keys/types/ranges fail; credentials are never configuration. A change in roots/account/context requires explicit re-pairing review, not editing arbitrary IPC payloads.

Before live publication, confirm operational ownership of managed files and capture a canary/rollback baseline. Before daily activation, require T09 evidence, configured daily time and the operator's A5 approval. Do not change lingering, stock sync state, host firewall, existing log maintenance, Chrome startup, or Miyo's service lifecycle as incidental installation work.

### 12.2 Retention and disk-full behavior

No automatic deletion of unverified, failed or recovery evidence in this release. Count all tool-owned `daily/` files toward the 10 GiB state cap and this run's raw/staged/temporary/backup bytes toward 2 GiB. Check free space on the staging and native-chat filesystems before beginning a new transfer/publication; account for temporary plus backup copies, not only final Markdown size.

At a cap or insufficient reserve, persist `disk_budget_exhausted` when possible and stop before the next irreversible unit. An out-of-space journal write is an explicit recovery failure; do not acknowledge success. This conservative release will eventually require operator-managed retention if it runs indefinitely. Report remaining capacity and the exact blocked reason; do not pretend retention is solved by stopping.

A later retention feature needs separate authorization and tests limiting deletion to exact owned, successfully verified artifacts after an agreed retention period. The original recovery directory is never eligible. No broad deletion of the shared parent state directory or live chats.

### 12.3 Operational rollback

Disable only the new daily timer, request pause and allow the worker to reach its safe publication boundary; then stop the worker and disable the custom extension. A timed-out stop preserves journal/backups for recovery rather than declaring a clean rollback. Remove only the exact custom native-host registration when uninstalling.

Keep imported chats, worker state and original recovery evidence. Stopping the scheduler does not undo imports. Revert the code release only if its protocol and state schema remain compatible; otherwise stop and use the qualified migration/restore procedure. Never replace the entire running Miyo manifest, delete vectors, reconnect sync or restart Miyo as automatic rollback. Undoing published data is a separately approved coordinated operation.

### 12.4 Decisions and qualification gates

| Decision/gate | Chosen policy or owner | Blocks |
|---|---|---|
| Architecture and scope | Separate extension + Node worker; one paired context; native sync off; text-only | Fixed baseline for implementation |
| Planning vs installation authority | Authorization levels in document control | No live action until its level is authorized |
| Schedule | 04:00 America/New_York, up to 10 minutes jitter proposed; operator confirms | T10 only, not offline development |
| Browser closed | Defer until existing browser is available; no automatic launch | Exact-time promise, not job durability |
| Standalone browser feasibility | T02 implementing agent proves minimal-permission transport and identity/context | Broader collector/import investment and live rollout |
| Native adapter compatibility | T05 qualifies installed bundle/schema/rendering; reviewer checks evidence | T07 live publication |
| Existing recovery status | Fresh full relevant verification; historical monitor ignored for liveness | Additional live import, not offline tests |
| Concurrent file writers | Operator-managed native files have one publication writer; late checks/backups still required | Live activation if this cannot be established |
| New dependencies or permissions | None preapproved; disclose a concrete necessity and obtain scope approval | Only the affected task, not unrelated offline work |
| Retention beyond caps | Stop-before-full initially; future cleanup separately designed/authorized | Continued operation when cap reached |

No unresolved product-policy question is delegated silently to the implementation agent. Browser feasibility and installed compatibility are empirical gates with specific pass/fail actions, not claims already proved. Routine internal modules, SQL table layout and test factoring remain delegated within this contract.

## 13. Agent handoff, completion evidence, and course correction

Implement in task order within the authorization actually granted. Before editing, refresh canonical root, applicable instructions, branch/HEAD, dirty files and relevant runtime compatibility. Read this document as the controlling implementation contract when v2 is adopted; do not regenerate another PRD or translate it into BMAD/Spec Kit documents.

Normal source scope is this repository's extension, worker, adapters, schemas, tests and installation directories; documentation belongs here alongside the code. Preserve unrelated changes and historical operator drafts outside the repository. Bootstrap authorizes only the initial repository scaffold/commit/publication. Later work needs its own applicable authorization; no dependency, installation, service or live-data change is implied by publishing this plan.

For each task, return a compact record: outcome, owned files, requirement/AC coverage, exact validation commands with actual results, skipped checks and reason, deviations, evidence locations and remaining gates. Use one continuation checkpoint in this plan or the implementation README, not several competing progress databases. Private runtime receipts remain in the new state namespace, never in source.

A release receipt includes plan ID/hash, source commit plus dirty-file digests where relevant, Node/Chrome/extension/worker/Miyo versions, bundle/schema/renderer/protocol/config fingerprints, authorization scope, run/attempt/scan interval, selected-version digests, test outcomes, native retrieval evidence and unresolved limitations. Do not include credentials or raw private chat text in public summaries.

Review the exact candidate and relevant base/artifacts against R01–R16, not merely the implementer's summary. Changed product semantics, authentication, API/schema, account/root, rendering or verification oracle invalidate affected evidence. An internal refactor need not invalidate unrelated live qualifications if equivalence is demonstrated and recorded.

If actual evidence contradicts this plan, classify it: implementation defect, disproved technical assumption, missing product/security decision or changed requirement. Correct the owner of the problem. Stop before crossing an authorization/trust/data boundary; do not weaken acceptance to manufacture completion. A failed T02 is a bounded feasibility finding, not permission to switch to cookie export/debugging or patch the stock extension.

### Definition of done and current checkpoint

Implementation-complete means T01–T09 requirements and tests have evidence, the full on-demand path and deterministic no-op repeat pass, source/runtime behavior match, and operational documentation is accurate. Daily-delivery-complete additionally requires authorized T10 and an actually verified scheduled run. Keep these labels separate.

- [x] Original v1/v2 engineering requirements transferred into a public-safe standalone specification.
- [x] Repository guidance, supporting documentation and non-runtime scaffold prepared.
- [x] Specification separates required outcomes, technical contracts, tasks and acceptance evidence.
- [x] A1 functional implementation authorized and actual runtime source created.
- [x] T01 contracts/harness qualified at the offline layer described below.
- [x] T02 standalone browser proof passed under A2 for the approved token-bound personal-account route.
- [ ] T03/T04 durable collection and control passed.
- [ ] T05/T06 native publication/recovery/verification passed.
- [ ] T07 live new/updated canaries passed under A3.
- [ ] T08 supervised services qualified under A4; timer remains disabled.
- [ ] T09 complete on-demand and no-op evidence accepted.
- [ ] T10 schedule approved, enabled and first scheduled run fully verified.

**Current checkpoint — T01:** implemented version 1 configuration, request/reply,
status and per-request receipt contracts; fixed limits; bounded native framing;
private-path/config validation; SQLite transaction/backup primitives; and
process-lifetime `flock` ownership. Source lives in `src/`, four contracts in
`schemas/`, and flat offline test suites plus synthetic helpers in `tests/`.
No CLI, extension, collector, coordinator, importer, installer or service is
implemented or installed by this checkpoint.

Validation on Node 22.23.2 and Linux: `npm test` passed 62 tests;
`npm run check` and `git diff --check` passed. Tests include schema-shape parity,
identity/version/unknown-field rejection, UTF-8/frame/chunk limits, consumer
backpressure, SQLite commit/rollback across SIGKILL, busy errors, consistent
backup restoration, unknown-schema refusal, and competing lock owners through
crash/restart. Safety regression tests preserve external sentinel files when
database sidecars are hard links and reject invalid creation inputs before
mutation. PR review added regressions for premature commit-result receipts,
strict semantic versions, existing-directory permission preservation and
unknown-schema checks that must not create SQLite sidecars. The schema-version
fixture explicitly creates a private file instead of depending on the runner's
umask. Backup destinations reject pre-existing sidecars without removing them;
new private files set permissions through their open descriptor. All state is
synthetic and temporary. Status validation checks indexed evidence before
verification and consistent connected/live/stale heartbeat evidence; process
ownership preflights the pinned `flock` executable before creating a lock file.
SQLite still emits its
experimental-feature warning on this pinned Node version.
Complete WAL/SHM read-only inspection may update transient SHM coordination
bytes; qualification observed unchanged main-database and WAL bytes, not
byte-frozen SHM. Missing-SHM and closed-WAL unknown-version regressions prevent
creating new sidecars during schema diagnosis.

T01 contributes the schema/local-boundary cases of AC02, AC12 and AC13 plus
foundations for R02, R11, R12, R15 and R16. It does not claim the full live ACs,
durable coordinator/idempotency behavior, all-leg browser memory qualification,
power-loss durability, deployment-filesystem qualification or installed Miyo
compatibility. Chrome identity/context mapping and Miyo bundle/schema/renderer
fingerprints remain unqualified. No upstream capture, production data access,
native-host registration, service start or timer activation occurred.

The scaffold's canonical plan contained a saved tool-output truncation that
removed part of section 6.3 and sections 6.4–7.3. Those requirements were restored
verbatim from the retained operator v2 draft and compared for equality; no
private inventory was imported. Repository validation now rejects captured
truncation markers and missing numbered plan sections. This repairs the
transferred contract without changing its requirements.

**Next gate:** T02's minimal extension/native-host/private-staging proof for one
explicitly selected conversation under A2. Its source can be prepared offline;
pairing and authenticated capture need that scope. T03–T06 remain sequenced after
successful browser feasibility. Keep one progress record here.

**T02 continuation — not live-qualified, not closed:** the operator authorized proceeding
to T02 and then its remainder. Offline modules cover the fixed page collector, owned-document bridge,
sequential probe client, exact-origin native framing/forwarding and a private
single-probe staging receiver. These preserve protocol version 1 and do not add
dependencies, an HTTP listener, catalog work, publication, services or scheduling.
The receiver is an injected qualification harness, not the full T03 coordinator;
the caller must hold process ownership and supply explicit private roots and a
qualified body validator. Failed or uncertain attempts cannot be reset/refetched.

Initial T02 validation on Node 22.23.2/Linux passed 110 tests, including
the original 62 T01 tests, under CI-like umask 0022; repository and diff checks
passed. A synthetic vertical test runs the actual serialized collector through
native framing into SQLite-backed private staging, verifies exact body bytes and
SHA-256, and checks token/cookie sentinels never cross the page boundary. Added
negative cases cover lost ACK/ports/documents, retained chunk replay, bounded
streaming and JSON preflight, stalled fetch/read timeout, conflicting receipts,
missing-artifact replay, clock/boot changes and persistent Retry-After deadlines.
An injected SQLite receipt failure after artifact fsync preserves the orphan,
returns no success ACK and prevents continued writes until restart/review.
These are synthetic T02 portions of AC01, AC02, AC06 and AC13, not completed live
ACs, full T03 lifecycle qualification or a deployment-filesystem/power-loss proof.

The continuation adds an uninstalled MV3 qualification package with an explicit
popup/controller, persistent single-attempt start fences, a pinned native entry
and pure launcher renderer, and a bounded private Unix-socket transport. The
native host does not claim the worker lock or launch a worker. A synthetic
cross-process test composes the real native entry, socket and SQLite receiver
under OS `flock`, rejects a competing process without removing its socket, and
checks crash/restart ownership. No production configuration or pairing key is
shipped; no new permissions beyond section 4.1 or dependencies were introduced.

Continuation validation on Node 22.23.2/Linux: all 139 offline tests passed,
including the large synthetic page-to-native-to-Unix-socket-to-staging digest
test and the cross-process ownership test. Repository and diff checks passed.
Review corrections covered the native-client/server ownership boundary, stale
popup state without a start fence, socket path truncation limits, frame-prefix
headroom, lost-port deadlines, server reply IDs, cooperative receiver cancellation
with listener fencing, escaped source patterns and safe socket close. Popup structure/controller
tests are not visual, keyboard or real-Chrome qualification. No extension was
loaded, native host registered, ChatGPT request made, Miyo data changed, service
started, timer enabled, or commit/push performed during that offline validation.

Only a reserved-origin synthetic adapter is present. Real ChatGPT initialization
fails closed: principal-to-Miyo mapping, observed workspace/context and the actual
session/body contract are still unqualified. Read-only retained-helper inspection
confirmed the historical token/principal fields and request route, but no active
workspace check; parsed recovery wrappers are not raw HTTP/schema qualification.
There is no capture-capable installed release, running service or live capture proof.
Browser ownership records survive interruption without adopting or closing old
tabs; qualification tab cleanup is deliberately operator-owned. The operator has
now privately selected one conversation and the existing signed-in profile;
profile metadata and connected-browser inventory were checked without reading
authentication material. Those identifiers remain outside this public record.
The browser automation surface blocks extension management and prohibits
workarounds, so extension loading requires an operator-performed manual handoff.
A private owner-only unpacked handoff artifact has now been prepared from the
nine extension files, with a locally generated public manifest key for stable
extension identity. Readback verified source equality except that key, module
syntax, exact file inventory and safe ancestor permissions. It remains
capture-disabled and is not a selected production release. The operator now
reports the handoff package loaded and enabled in Chrome, and supplied a
screenshot showing the expected unconfigured popup and disabled Start control.
This verifies the displayed disabled state, not the native transport or capture.
Preparing the original handoff artifact made no authenticated requests and did
not register a native host.

**T02 local connection checkpoint:** an explicit popup connection check and a
separate foreground status-only endpoint now use existing protocol-v1 global
`get_status`; no protocol schema, dependency or permission was added. The check
does not read/write capture configuration or fences, create a page, fetch
upstream, grant leases/permits, or enable Start. The endpoint reports zero
upstream budgets, blocks all other operations, verifies inherited kernel flock
ownership and expires after ten minutes. A passing check is historical evidence
of that local round trip, never capture completion or ongoing worker health.

All 156 offline tests passed on Node 22.23.2/Linux; repository and diff checks
passed. Review corrections reject invalid calendar timestamps, discard cached
popup completion when configuration disappears without clearing the fence, and
bound ownership-loss shutdown. The operator-loaded package was updated in place
with its public manifest key unchanged; its original nine files were preserved
outside the loaded directory. A separate owner-only private snapshot/configuration
and exact-origin custom native-host registration were prepared and read back.
Full safe ancestor checks and source equality passed; the stock Miyo host's digest
was unchanged. A direct local native-launcher round trip, foreign-origin rejection
and competing-owner/socket-preservation check passed. These did not use Chrome.

The operator's next screenshot confirms the updated popup loaded and its explicit
**Check local connection** action reported unavailable, with Start still disabled.
Follow-up inspection found no receiver process, listening socket or lock owner;
the leftover socket was not evidence of a live endpoint. The prior command session
was unavailable, but its termination cause was not established. An explicit
foreground restart under the existing lock checks restored the listener, and
the direct native-launcher round trip again passed the popup's reply validator.
The operator then supplied a screenshot of **Local connection check passed.
Capture is still disabled.** while the foreground session was kept open. This
is operator-supplied live Chrome-to-native status evidence, not authenticated
account/workspace, session/body, or private-staging qualification. Start remained
disabled. The receiver was subsequently stopped; no ongoing liveness is claimed.
Read-only inspection of the operator-selected conversation's profile menu also
showed the requested account and a selected personal-account context. The menu
was dismissed without switching accounts or changing settings. This is visible
UI evidence only: it does not establish a current session principal, effective
request context, Miyo mapping or session/body response contract. No private UI
content or account identifiers were copied into the repository.

Stopping through a terminal exposed duplicate-signal shutdown interruption and
a leftover socket. Two new regression tests reproduced the failure before the
source correction: handlers now remain installed through cleanup/child exit and
the launcher forwards only the first signal. All 158 offline tests passed after
the fix. The original private snapshot remains unchanged; the shutdown fix is
source-tested, not yet packaged or browser-tested. A locked-owner restart followed
by a single directed termination cleaned up the exact stale socket and left no
receiver running. The check is not a service, and termination or expiry requires
an explicit restart rather than an automatic background worker. No authenticated
request, conversation capture, Miyo write, timer activation, commit or push was
performed. Browser automation was not used to bypass extension-management policy.
Current context and compatibility evidence must be qualified before authenticated body dispatch;
configured principal/context equality is not a substitute. Pairing must use a
private reviewed release with safe ancestors, not relaxed checkout path checks.
See [T02 qualification boundary](t02-qualification.md) for implemented interfaces,
official API references and the remaining proof. The T02 checkbox above remains
open; `probe_complete` is not catalog or verified-run completion.

**T02 session-only continuation:** at the operator's request, the preceding
transport/package/checkpoint snapshot was committed locally as `bdff29a`, with
158 offline tests passing and no push. Staged review and private-marker checks
found no private data; the secret scanner's sole finding was a reviewed benign
storage-key constant, not a credential.

The next source slice adds `runSessionCheck` using existing protocol-v1 session
permits, durable dispatch ACKs and receipts, then stops without advertising,
claiming or dispatching body work. Its result is `session_check_complete`, never
capture/probe/catalog completion. Both clients reject session results larger
than one 16 KiB chunk, extra fields, changed identity/context and noncanonical
JSON before native forwarding. A receiver's explicit `session-only` scope
durably refuses body work and cannot be promoted to conversation scope by
reopening the same root. Its distinct binding hash also rejects reopening by
older conversation-only code. Existing default conversation roots retain their
contract; a new private scope is not a reset of failed or uncertain evidence.
Session-only scope needs no body validator and cannot use a supplied validator
to admit body work.

Validation: all 171 offline tests pass, including both full-probe and session-only
page-to-native-to-private-staging paths, strict session serialization, durable
scope binding and legacy conversation-root compatibility. Repository checks and
diff whitespace checks pass. Independent review found no security blockers;
its documentation correction was applied. These are synthetic proofs, not live
Chrome or account-context qualification.

This slice remains source-only: it is not wired into the installed popup, no
private package was changed, and the reviewed real-adapter registry remains
empty. Current session response requirements, effective workspace/context
attestation and read-only principal-to-Miyo-account mapping remain unresolved.
Do not infer them from the prior UI observation or configured values. No new
browser permissions or wire operations, authenticated requests, capture, Miyo
writes, service/timer activation or push occurred during this continuation.

**T02 setup-inspection continuation:** the preceding session-only slice was
committed locally as `71ed86e` after all 171 offline tests, repository checks,
staged whitespace checks and a clean staged secret scan. Nothing was pushed.
Read-only local evidence established a unique nonblank historical Miyo account
candidate and no active native-sync accounts. The selected conversation is not
yet in the manifest; that does not disqualify a new-chat proof or authorize any
import. Current browser principal equality is still unproved.

The current page's public first-party code distinguishes personal/workspace
account structure, session principal/account IDs, page-local workspace selection
and token account scope. These are implementation clues, not a current response
or successful API-context attestation. No credentials or raw authentication
responses were read during that source inspection. The operator explicitly
approved the bounded setup exception above to resolve the previous requirement
for a configured context ID before observing it. The full capture adapter remains
disabled; setup cannot fetch a conversation, enumerate a catalog or write Miyo.

The approved setup path is now implemented through the explicit popup gesture,
fixed page adapter, session-only client flow and separate foreground receiver.
All 201 offline tests pass, including the real-lock setup entry with separate
runtime/staging roots, scope/replay fences, token non-export and original-byte
body preservation. Review corrections include awaiting receiver construction,
keeping the runtime socket root separate, and limiting canonical JSON enforcement
to sanitized session transfers. A final setup-only account-selection recheck
precedes native commit; regression tests prove mismatch prevents commit.
Independent review confirmed the reported blockers were addressed. Repository
and whitespace checks pass.

A private setup release and rollback copy have been assembled. The previously
loaded extension directory is updated on disk; its manifest, identity, permissions
and native-host registration are unchanged. Source parity, owner-only modes,
configuration consistency and an offline setup-ready/capture-disabled status
were verified. This is prepared code, not a Chrome reload or live qualification.
The setup staging directory remains empty and no receiver has been started.
The next operator step is to reload the existing extension and confirm readiness;
only then start the bounded foreground receiver and request the explicit
**Inspect signed-in session** gesture. No authenticated request, Miyo write,
service/timer activation or push occurred during this setup preparation.

**T02 startup diagnostic correction:** after the setup package was committed as
`8b23901`, the operator ran the explicit inspection. It created the expected
qualification tab but the reopened popup reported uncertainty. The tab visibly
showed the signed-in personal-account home page; this is not backend identity
attestation. Read-only receiver evidence remained at `new` with zero accepted
requests, permits, receipts, chunks or artifacts. No collector-issued session or
body request was dispatched; ordinary traffic from loading ChatGPT is outside
that statement. The foreground receiver was stopped cleanly and its socket was
removed. The browser attempt and private staging evidence were preserved.

Offline reproduction found a concrete reporting defect: a startup rejection was
persisted as a `blocked` fence, but the reader rejected that state and reported
`uncertain` on reopen. The fix preserves `blocked` as terminal and retains fixed
startup failure codes without raw errors. Older matching ownership records can
show only the last recorded milestone; the original browser failure remains
unidentified because the previous build discarded it. Status inspection is
read-only and cannot reset the fence, adopt a tab or dispatch a request. No
permissions, identity checks, retry rules or capture gates were relaxed.

Validation: all 209 offline tests pass, including blocked-fence restart behavior,
phase-specific failures, sentinel exclusion, legacy milestone redaction and no
retry effects. Repository checks, whitespace checks and the changed-source secret
scan pass; focused independent review found no remaining issue in this fix.
The same private extension directory now contains the diagnostic correction with
a rollback copy retained. Readback verified source parity and unchanged manifest,
private configuration, native-host registration and staging database. The next
manual step is reload-and-open-popup only, to inspect the saved diagnostic; no
new inspection gesture, receiver start or attempt reset is part of that step.
The corrected code is not yet live-verified, and the original startup cause is
still unresolved. No new authenticated collector request or Miyo write occurred.

**T02 isolated startup-only diagnostic preparation:** the operator subsequently
reloaded the reporting fix and supplied a screenshot showing the saved
document-bound milestone with the original error unavailable. This verifies the
new legacy reporting UI, not the original failure cause. The operator then
approved one isolated startup-only diagnostic, preserving the failed inspection
and issuing no collector session/conversation requests.

The diagnostic is implemented behind a separate private constructor flag; the
public package keeps it disabled. Its exact popup gesture requires a reviewed
private setup configuration and a consistent prior terminal failure fence. It
writes a new durable diagnostic fence before browser effects, uses a separate
owned-document record, and never changes the old inspection records. The fixed
page collector's startup-only mode retains the original context gate, blocks all
dispatches permanently and cannot be promoted after a context rejection. The
helper exposes no page handle and validates abort cleanup before reporting a
pass. No native connection, receiver or authenticated collector request is part
of this diagnostic. Ordinary traffic from loading the ChatGPT home page remains
outside the no-collector-request guarantee. Success cannot qualify identity or
unlock inspection/capture; every attempted diagnostic remains non-retryable.

Validation: all 230 offline tests pass. Coverage includes private/default gates,
malformed and orphaned records, inconsistent prior failure pairs, restart and
concurrency fencing, no-fetch page dispatch rejection, separate ownership,
uncertain cleanup, fixed-code UI and original-evidence preservation. Independent
review identified the inconsistent-fence case; the correction and regression
test were re-reviewed with no remaining substantive finding. Repository and
whitespace checks pass. Secret scans found no credentials: tests/docs were
clean; the extension scan flagged only the pre-existing public storage-key
literal, which was manually verified against HEAD. No scanner rule was weakened.

The same private extension directory now contains this diagnostic, with a
rollback copy retained. Readback verified source parity, owner-only file modes,
and that the private configuration changed only by adding the diagnostic enable
flag. The manifest/extension identity, native-host registration, setup config and
staging database are unchanged. A synthetic status-only import of the private
package keeps the old inspection blocked and exposes only the new diagnostic;
this is not a live Chrome test. The receiver socket remains absent. Next manual
step: reload the existing extension and click **Diagnose startup (no fetch)**
once, then report its separate message. Do not retry inspection, clear storage,
remove/reinstall the extension or start a receiver. No live diagnostic was run,
no Miyo state was written, and these source changes remain uncommitted.

**T02 background-setup continuation (current):** the operator's next screenshot
showed the first startup-only diagnostic locked with `page_initialization_failed`.
That old aggregate code cannot distinguish a rejected script invocation from an
invalid collector result. A second, separately fenced no-fetch diagnostic now
has source and synthetic coverage, but it was not packaged or run: the operator
instead approved reassessing page-only credential isolation against installed
Miyo Capture and Desktop. The comparison and narrow authority amendment appear
above and in [design evidence](design-evidence.md).

The implemented alternative is `background-setup-inspection`, selected only by
explicit private configuration and a trusted popup gesture in a non-incognito
extension context. It opens no page and runs no injected script. The existing
ChatGPT host permission suffices; no permissions or dependencies were added.
One fixed credentialed session GET follows the native worker's durable permit
and dispatch ACK. A fresh collector UUID is recorded separately from Chrome
document IDs, and old receiver scopes reject the new capability. Tokens and raw
auth responses are not cached, forwarded, logged or persisted. Principal,
personal-account and JWT account/expiry checks precede canonical identity-only
output; response bytes/time and error metadata are bounded. New extension keys,
receiver scope/root and `background_setup_complete` terminal state preserve both
old failed page records and prevent retry/promotion. This evidence is a candidate
backend context only, never visible-page attestation or body qualification.

Source validation currently passes 270 offline tests, including a complete
background collector-to-native-frames-to-socket-to-SQLite proof, ACK-before-fetch,
credential sentinel exclusion, scope isolation, terminal reopen fencing,
lost-dispatch-ACK/no-fetch, lost-commit/no-retry, private/default/incognito gates,
popup sender checks and unchanged earlier records. Independent review found a
credential-reference lifetime issue under ignored aborts; abort-aware waits and
bounded cleanup now settle the collector's own task, with raw response/parser
references dropped before hashing. The fix and regression tests were re-reviewed
with no remaining release-blocking finding. Background `reconcile_dispatch` is
schema validation only in T02: the capability is not advertised, the operation
is blocked, and uncertain work stays locked for operator review after restart.
Repository/whitespace checks pass. Secret scans found no credentials; the only
extension finding remains the pre-existing public storage-key literal, manually
checked against HEAD. Private identifier/path marker scans also pass.

The existing private extension directory now contains the background flow, with
the stable manifest/identity/permissions unchanged and prior configuration
preserved. Its background setup configuration is enabled separately; the unused
startup diagnostic is disabled, without clearing either old Chrome fence. A new
owner-only source/receiver release and empty staging root are prepared. The custom
native-host registration now points to that snapshot's launcher so native
validation recognizes the new capability and collector field; its name/origin/
type are unchanged. The previous extension and registration are retained for
rollback, and the old private setup configuration/database hashes are unchanged.
Stock Miyo Capture and its registration are untouched.

Readback verified source parity and owner-only modes. A synthetic import/status
smoke test of the private package confirmed no automatic fetch, native connection,
tab/script effect or storage write; the original inspection remains blocked,
only background setup is ready, and capture remains disabled. These are not live
Chrome results. The receiver remains stopped and its socket absent. Next manual
step: reload the existing extension, then notify the operator before clicking
**Inspect session in extension**, so the bounded receiver can be started just in
time. Do not clear extension storage, reinstall, retry the old inspection or
click before that receiver is ready. No authenticated background request or live
Miyo operation has run. Source changes remain uncommitted.

**T02 live background setup result (supersedes the reload handoff above):** after
the operator reloaded the private package, the bounded foreground receiver was
started with verified exclusive OS-lock ownership, an owner-only Unix socket and
fresh `background-setup-inspection` state. The operator clicked the separate
background inspection once and supplied the completion screenshot. Read-only
verification found the durable `background_setup_complete` state, six successful
native protocol receipts, one session permit, zero body permits, no blocker and
no active permit. The single committed artifact contains exactly the canonical
principal/context fields: the principal matches the approved historical binding,
the context is a bounded candidate, and artifact size/SHA-256 match both stored
evidence and the commit receipt. No raw auth response or credential fields are
present in that artifact. `attested` remains false; no body artifact, catalog,
publication or Miyo operation was performed.

The verified receiver was stopped gracefully (exit zero), and its process,
socket listener and OS-lock ownership were released. Existing failed page
attempts remain preserved; their old warning does not negate this separate
success. Live session setup is now qualified for the tested package/profile,
but T02 remains open for the selected-conversation body proof. Next is a reviewed
body-request/context-binding contract and a separately bounded selected-body
test; neither success here nor the discovered context enables that step
automatically. Source changes remain uncommitted. No further manual click is
needed until the next package/test handoff.

**T02 selected-body preparation:** at the operator's request, the preceding
source, diagnostics and verified setup checkpoint were committed locally as
`807c31a` with all 270 offline tests passing. The staged private-marker scan
passed; Gitleaks flagged only the already-public non-credential storage key,
verified against the parent commit. Nothing was pushed and the tree was clean
at that commit boundary.

The next slice inspected the shipped stock request and response consumers.
Their single-conversation `GET`, rather than our synthetic batch route, informs
the new `adapters/chatgpt-selected-conversation.mjs` draft. It is a pure route
descriptor and parsed-response validator, with no fetch/token/storage/browser
effects and no live adapter registration. It verifies exact selection, bounded
timestamps/title/node count, a complete connected mapping with consistent
parent/child references, and basic message structure; optional metadata remains
opaque and rendering/import compatibility is not claimed. Its stricter graph
checks are project acceptance policy, not a claim of observed live completeness.
Tests cover wrong IDs/envelopes, auth-shaped fields, malformed/partial graphs,
cycles, duplicates, deep/oversized mappings, accessors and absence of side effects.
The draft's eight focused tests and the full 278-test offline suite pass, as do
repository structure and whitespace checks. This is not live body qualification.

The unresolved body-context decision is explicit: stock code sends both bearer
authorization and cookies without independently proving the selected workspace.
The proposed next proof would bind a fresh background token to the verified
personal backend account and omit cookies from one selected-body GET. This would
not attest the visible tab's workspace. Approval of that extension to the
background-credential exception is pending; no body collector, package change,
receiver start or live request was performed in this preparation. Existing live
setup/failed-page evidence and the stopped receiver remain untouched. T02 is
still open, and the draft following the commit remains uncommitted.

**T02 approved selected-body continuation (supersedes the pending decision
above):** the operator approved proceeding with the token-bound, cookie-free
one-conversation proof. The implementation adds a separate background collector,
client mode, private popup configuration/action, durable extension fence and
receiver scope, and explicit foreground selected-conversation entry. Public
configuration stays undefined. The single source contract lives in the extension
and is reexported under `adapters/` for native validation, so both boundaries
use the same fixed selected-ID/graph check. Successful canonical identity
commit sets scope-local `selected_body_ready`, never `attested`; only this new
root may grant the body permit. Completion is `background_probe_complete`.

Validation on the pinned runtime passes 307 offline tests, repository checks
and whitespace checks. The real framing/socket/SQLite synthetic test transfers
multichunk UTF-8 selected-body bytes with matching digest and no credential
sentinels. Additional tests cover exact body selection, mismatched context,
60-second token lifetime/expiry/clock changes, no-cookie GET, durable-ACK loss,
body/schema/size rejection, hung reads/fetches, permanent one-shot UI fences,
trusted sender/configuration, preserved old records and native scope refusal.
Independent review caught unread rejected HTTP responses retaining network
ownership; both background collectors now cancel/abort before dropping those
references, and dedicated regressions pass. Re-review found no remaining
actionable blocker in its bounded scope. Privacy-marker scanning passes;
Gitleaks reports only the pre-existing public storage-key false positive.
This establishes offline behavior, not a successful live endpoint/body-schema
qualification. No Miyo operation, live request, source commit or push occurred
in this implementation slice. Packaging/live handoff evidence follows here.

**Selected-body package handoff:** a new owner-only private source/receiver
snapshot, empty staging root and selected configuration are prepared. The
existing unpacked extension directory was updated with the reviewed modules
while preserving its manifest key, identity, permissions, prior configuration
and all Chrome storage fences. A rollback copy of the prior extension and
custom registration is retained. The custom native host now points to the new
snapshot's pinned launcher; its allowed origin/name/type remain unchanged.
Stock Miyo Capture and its registration were not modified. Readback verifies
package/source parity, owner-only modes, exact config acceptance and unchanged
prior setup configuration/database digests. A private-package synthetic
startup/status smoke test reports only the new action ready, with zero fetch,
native, tab/script, alarm or storage-write effects.

The receiver remains stopped, its socket is absent, and new staging is empty.
Next manual step: reload the existing extension and report that reload; do not
click yet. Then start the ten-minute foreground selected-body receiver and
request exactly one **Fetch selected conversation once** click. Preserve any
failure and do not retry. Chrome reload, selected-body HTTP acceptance, live
schema/digest proof and T02 completion remain unverified. Source changes remain
uncommitted; no push, live request or Miyo operation occurred.

**T02 live selected-body result (supersedes the reload handoff above):** after
the operator reported reload, preflight verified the pinned private runtime,
loaded-package parity, unchanged prior setup evidence, empty new staging and
absence of another receiver. The foreground selected-body owner held the
exclusive kernel lock and owner-only listening socket before the operator's
single click. The screenshot captured the popup's intermediate `starting`
state; durable receiver evidence subsequently showed `background_probe_complete`.

Read-only verification found exactly one session permit and one body permit,
two committed private artifacts, no active permit/blocker and all native
receipts successful. Native protocol-message count is not an HTTP-request
count. The identity artifact is exact canonical principal/context data matching
the private binding. The body is strict UTF-8, matches the selected conversation
and complete graph contract, and its original byte count/SHA-256 match both
stored evidence and the commit receipt. No authentication response is staged.
The tested runtime was Node 22.23.2 and installed Chrome 153.0.8010.36; this
evidence is limited to the pinned source/configuration and personal-account
route. `attested` remains false: visible-page workspace selection was neither
used nor qualified. No catalog, rendering/import, Miyo publication/indexing or
scheduled-service claim follows from this result.

The receiver was gracefully stopped with exit zero. Readback proved the
process, socket listener and lock ownership were released; SQLite quick-check
passed and the completed state/artifact digests survived shutdown. Prior setup
configuration/database digests remain unchanged, and old failed attempts were
not reset. No retry, Miyo operation, commit or push was performed. No further
manual click is needed. This passes the amended bounded browser-to-staging
feasibility gate; T02 closeout should reconcile its scoped acceptance evidence
before the T03 durable coordinator begins. Public configuration stays disabled,
and untested general capture/catalog/workspace/import layers remain open.

**T02 closeout:** the amended browser-feasibility task is complete for this
bounded route. The original page-startup failures remain preserved, not
retroactively qualified; the successful background attempt created no owned
tab and made no visible-workspace claim. Evidence is scoped as follows:

| Acceptance | T02 evidence | Still outside this closeout |
|---|---|---|
| AC01 | One live selected-body read and private commit; synthetic credential-sentinel exclusion, fixed routes and no Miyo endpoints | General capture, native import and production activation |
| AC02 | Live pinned principal/personal-context match; synthetic mismatched identity/schema and cross-scope rejection | Visible-workspace switching and T05 manifest/account ownership |
| AC06 | Exclusive live owner; synthetic duplicate/lost ACK, expired/uncertain dispatch and terminal reopen fences | T03 general coordinator lifecycle and safe resumption/reconciliation |
| AC13 | Exact live original-byte digest; synthetic multichunk UTF-8, frame/body caps and stalled-consumer tests | T04 full-catalog resource behavior and later deployment-scale measurements |

The final offline candidate retains 307 passing tests with repository and
whitespace checks passing. Independent closeout review found no additional
release-blocking source issue. Public configuration remains disabled, all
private live artifacts remain outside Git, and neither a general-purpose
service nor a Miyo importer is delivered. Catalog-fixture derivation and
terminal-cursor qualification are open T04 obligations. T03 is the next source
task after this T02 delivery; this closeout does not activate it or authorize
another live request. Publication of these source changes is separately
authorized by the operator's commit/push/PR request.

**T02 publication review:** the first review batch identified a synchronous
tab-lookup failure that left page-load listeners registered until timeout.
A regression reproduced the leak, and the load wait now routes synchronous
errors through the same immediate cleanup as promise rejections. Both paths
preserve the uncertain one-shot record and create no replacement tab or script
call. The full offline suite passes 308 tests with repository and whitespace
checks. This page-bridge correction is source-only; the completed private
background package was not redeployed or retried. A suggested Windows UID
fallback was declined because the qualified transport requires Linux ownership,
private modes, Unix sockets and kernel locks; bypassing UID verification is not
a portability qualification.

The next released batch found two additional hardening gaps. The shared
selected-response validator now rejects credential-shaped top-level fields
after case, separator and Unicode compatibility folding, rather than relying
on a short exact-case list. Conversation text is not scanned or rewritten.
The reviewed contract fingerprint changes accordingly. Read-only validation
of the retained private body passes the stricter check and original digest;
no new HTTP request, receiver start, package update or state write was made.
Terminal body-probe recovery now checks both the session and body artifacts,
including private paths, sizes and digests, and fences missing/corrupt evidence.
Setup-only roots still check their sole session artifact. Synthetic regressions
cover the browser rejection boundary and terminal recovery. Suggested lexical
path rewrites were unnecessary because the existing helper rejects all such
aliases; the native output error guard remains required for late/cancelled
write failures on its dedicated process-lifetime stream.
The combined second-review candidate passes all 312 offline tests, repository
checks and whitespace checks; no live deployment was performed.

The third released batch contained no new behavioral defect. Its redundant
body-only stage conditional was simplified. Two claimed late Promise.race
rejections were checked against both actual bridge paths with synthetic Chrome
APIs and strict unhandled-rejection mode: late failures are already observed by
the race and neither escapes. No dummy catch or browser deployment is needed.

The final review closeout reproduced a failure-receipt acknowledgement gap.
Every qualification route now reports `probe_failed` only after an exact,
correlated positive `request_failed` reply with `recorded: true`. Negative,
malformed or lost acknowledgements leave `dispatch_uncertain`; the original
receipt is persisted before forwarding, with no retry, replacement request ID
or additional permit. Regressions exercise all five page/background entry
routes. Package engine metadata and the repository check now require exactly
Node 22.23.2, matching the existing runtime guards. The qualification and
architecture docs distinguish the completed selected-route proof from broader
unqualified capture. All 314 offline tests, repository checks and whitespace
checks pass. These are source-only corrections; no private package, browser,
receiver, retained proof or Miyo runtime was changed.

## 14. Evidence and primary references

The L-series labels preserve traceability to the original design observations.
Their public-safe summaries are below; private artifacts are deliberately not
linked, copied or required to run the scaffold checks. They are not substitute
evidence for future compatibility or deployment qualification.

- **L1:** [Agent guidance](../AGENTS.md), repository scope and preservation rules.
- **L2:** [Repository ownership](repository-ownership.md), code versus operator-data boundaries.
- **L3:** [Project README](../README.md), current scaffold stage and available checks.
- **L4:** [Design evidence](design-evidence.md), manual sync-off route and watcher/indexing race.
- **L5:** [Design evidence](design-evidence.md), native renderer, manifest identity and verification observations; recovery implementation remains private.
- **L6:** [Design evidence](design-evidence.md), browser session/catalog/body accounting observations; recovery implementation remains private.
- **L7:** [Repository migration](repository-ownership.md), original v1/v2 retained as historical operator drafts.
- **L8:** Historical reconnect/repair runbooks remain outside this repository and confer no authority to reconnect sync.
- **L9:** [Design evidence](design-evidence.md) and section 1 distinguish historical observations from unperformed qualifications. Installed `systemd.timer(5)` and `systemd.time(7)` remain deployment-side references.

Official references retained from the v2 design for its technical boundaries; actual installed-version qualification still takes precedence over assumptions:

- **S1:** [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) — registration, framing, process ownership and message limits.
- **S2:** [Extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) — ephemeral execution and connection lifetime.
- **S3:** [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting) — fixed function injection, document targeting and shared MAIN world.
- **S4:** [Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms) — browser-local wakeup behavior; recreate/check alarms rather than trusting an in-memory schedule.
- **S5:** [Node 22.23.2 SQLite](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html) — experimental built-in database interface and version-specific API.
- **S6:** [Node 22 networking](https://nodejs.org/docs/latest-v22.x/api/net.html) — local IPC; this plan uses filesystem permissions rather than claiming an unimplemented peer-credential layer.
- **S7:** [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key) — stable extension identity.
- **S8:** [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) — tab operations versus privileged tab-property access.
