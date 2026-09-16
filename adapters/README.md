# Compatibility adapters

This directory holds compatibility contracts. No copied vendor implementation
or qualified body-capture/Miyo publication adapter is included yet.

`chatgpt-selected-conversation.mjs` reexports the shared browser-side contract
from `extension/selected-conversation-contract.mjs`. It supplies a fixed single-conversation `GET` route and a pure
parsed-JSON validator for the selected ID, timestamps and connected message
mapping. Callers must enforce the existing byte limit and strict UTF-8 decoding
before validation. Optional metadata stays opaque; accepting it does not qualify
rendering, attachments, workspace ownership or import. A body response that does
not satisfy the draft must stop for review, not silently weaken the validator.

The route/consumed fields were checked against installed Miyo Capture and shipped
Desktop code, without copying their implementation. Graph completeness checks
are our conservative acceptance policy, not an assertion that all live responses
meet it. The contract performs no fetch, token handling, storage or browser effects.
The separately approved background selected-body collector uses this contract;
the recorded one-conversation live response passed its checks. That evidence
does not establish general schema coverage or catalog/import compatibility.
Public configuration stays disabled and no importer/rendering adapter is qualified.

Bind live use to qualified fingerprints and fail closed on drift. See the
[implementation plan](../docs/implementation-plan.md), especially T02 and T05.
