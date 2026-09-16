# Architecture

This describes the target design. T01 implements the shared contracts,
framing and local safety/durability foundations. T02 source modules exercise
the page/native/private-staging boundaries with synthetic inputs; the installed
runtime flow below remains unqualified and the larger worker/importer absent. The
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
```

The extension and worker remain in one repository because their versioned wire
contract and release qualification must evolve together. The native host is a
transport adapter, not a second coordinator.

The extension holds browser context; the worker holds persistent job ownership.
Credentials never leave the page context. Miyo remains the sole index dispatcher.
Imported bytes are not complete until the selected version passes independent
native metadata, vector and retrieval checks.

A user timer requests work; it does not own browser execution. Closed-browser
work waits for the existing browser. All triggers share one queue, request gate,
cooldown and journal. Status distinguishes historical success from live liveness.

No HTTP listener, Miyo fork, stock-extension patch, credential export or automatic
login is part of v1. Private endpoint and native-schema compatibility remain
empirical gates. The first vertical proof precedes a full scheduler investment.
