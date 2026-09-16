# Architecture

The approved T02 selected-body branch uses an explicit popup gesture, a fresh
session permit, exact personal-account/token binding, a separate body permit
and one cookie-free selected-conversation GET. It reuses bounded native
transport to a new private root, stopping at `background_probe_complete` with
`attested: false`. Tokens stay in short-lived extension memory; no retry,
fallback, catalog, Miyo write or scheduler is enabled. Setup and failed page
evidence remain separate. The controlled one-conversation proof has passed for
the recorded personal-account package, not as a general capture qualification.

This describes the target design. T01 implements the shared contracts,
framing and local safety/durability foundations. T02 source modules exercise
the page/native/private-staging boundaries with synthetic inputs, in addition
to the bounded selected-route live proof above. The broader installed
capture/worker flow below remains unqualified and the larger worker/importer absent. The
[implementation plan](implementation-plan.md) owns the detailed contract.

```text
Daily request / CLI / popup
            |
     durable local worker <--- private socket --- native host
       |          |                                  |
       |       verifier                       Chrome native messaging
       v                                             |
  staged data + journal                       custom extension
       |                                             |
  native Chats file/metadata                  fixed page collector
       |                                             |
  Miyo watcher -> index/search                 paced ChatGPT reads

Private setup branch (explicit popup action, public package disabled):

  extension background controller --permit + dispatch ACK--> one session GET
             |                                                   |
             +-- sanitized outcome / collector_instance_id ------+
                                      |
                             background setup receiver
```

The extension and worker remain in one repository because their versioned wire
contract and release qualification must evolve together. The native host is a
transport adapter, not a second coordinator.

The extension holds browser context; the worker holds persistent job ownership.
For ordinary page collection, credentials never leave the page context. The
approved background setup branch may hold short-lived session credential
material in extension memory only; it has no token cache, Cookies API access or
native credential export. It performs one session `GET` only after the local
permit and dispatch acknowledgement, never a body request. Its
`collector_instance_id` is distinct from a page `document_id`. Miyo remains the
sole index dispatcher.
Imported bytes are not complete until the selected version passes independent
native metadata, vector and retrieval checks.

A user timer requests work; it does not own browser execution. Closed-browser
work waits for the existing browser. All triggers share one queue, request gate,
cooldown and journal. Status distinguishes historical success from live liveness.

No HTTP listener, Miyo fork, stock-extension patch, credential export or automatic
login is part of v1. Private endpoint and native-schema compatibility remain
empirical gates. The first vertical proof precedes a full scheduler investment.
The background receiver completes only as `background_setup_complete`; the
extension reports `background_setup_inspection_complete`. The observed backend
context is candidate setup evidence, not workspace attestation, and failed
records remain available for review. The v2 startup diagnostic remains
source-only and is superseded by the current private setup packaging.
