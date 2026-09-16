# miyo-catchup

Daily and on-demand ChatGPT catch-up into native Miyo Chats, with Miyo's native
ChatGPT sync left disconnected.

**Status: T01 complete offline; T02 selected-conversation proof passed live.**
The private qualification package completed one separately permitted session
check and one token-bound, cookie-free selected-conversation GET. Sanitized
identity and original body bytes were committed privately; selected identity,
response contract, byte counts and SHA-256 matched the durable receipts. The
foreground receiver stopped cleanly afterward. Earlier session-only evidence
and failed page attempts remain preserved.

This establishes the tested personal-account browser-to-staging route, not
visible-workspace attestation, catalog completeness, native Miyo import or a
production capture service. Public configuration remains disabled and the
one-shot private attempt remains terminal. No Miyo data change was performed.
Versioned contracts, bounded native transport, private-path/SQLite ownership
and failure cases also have offline coverage; that coverage is distinct from
the controlled live result. T02 is closed within this amended scope; the T03
coordinator is next, while catalog and importer qualification remain later work.
See the [T02 qualification boundary](docs/t02-qualification.md).

This is an independent integration project, not an official Miyo or OpenAI product.

## Intended approach

- A small custom Chrome extension uses an existing signed-in ChatGPT profile.
- A native-message bridge transfers bounded conversation data, never credentials.
- A local worker owns pacing, cooldowns, checkpoints and recoverable imports.
- Miyo's existing watcher owns native indexing; the worker verifies the result.
- A user-level timer eventually requests daily work. Closed-browser work waits
  for that browser to return; it does not launch an alternate profile.

The separately approved **Inspect session in extension** action is a private,
one-shot setup path. After a local permit and dispatch acknowledgement it makes
exactly one session `GET`, retains only short-lived credential material in
extension memory, and transfers bounded sanitized evidence. It has no token
cache, Cookies API access, native credential export or conversation/body fetch.
Its observed backend context is a candidate value for later qualification, not
workspace attestation. The receiver ends at
`background_setup_complete`; the popup reports
`background_setup_inspection_complete`. Failed records remain terminal and are
preserved for review.

This does not bypass ChatGPT rate limits. The private web endpoints and native
Miyo adapter require explicit compatibility qualification.

## Start here

- [Implementation plan and acceptance contract](docs/implementation-plan.md)
- [Architecture and boundaries](docs/architecture.md)
- [Public design evidence](docs/design-evidence.md)
- [Repository ownership and migration](docs/repository-ownership.md)
- [Contributor workflow](CONTRIBUTING.md)
- [Agent guidance](AGENTS.md)
- [Security and private-data handling](SECURITY.md)

## Development checks

Use Node **22.23.2** (pinned in `.nvmrc`). The project has no package dependencies
and needs no `npm install`:

```bash
npm run check
npm test
```

These validate repository structure and documentation plus the implemented T01
contracts and runtime primitives using synthetic data and isolated temporary
files. Process tests exercise SQLite crashes/backups and OS lock ownership;
they do **not** qualify power loss, the eventual deployment filesystem,
authenticated Chrome capture, native Miyo import or production scheduling.
CI runs the same offline checks on public source only. See the test coverage
and remaining gates in the [implementation checkpoint](docs/implementation-plan.md#definition-of-done-and-current-checkpoint).

## Layout

```text
extension/       Qualification package source; real-page capture disabled
src/             Offline foundations, native entry/socket and private probe receiver
adapters/        Shared selected-response contract; Miyo adapters remain reserved
schemas/         Version 1 protocol/configuration/status/receipt contracts
tests/           Offline contract and runtime tests; synthetic fixtures only
systemd/         Future user service/timer templates (reserved)
install/         Pure pinned-launcher renderer; no automatic installation
scripts/         Working repository validation tools
docs/            Canonical specification and supporting documentation
```

Reserved runtime directories retain ownership READMEs. T02's explicitly paired,
one-conversation browser-to-local proof has passed for the recorded private
package; synthetic tests alone do not establish it. The full coordinator/importer
follows this scoped closeout, not automatic production activation.

## Licensing

A distribution license has not been selected. `package.json` is marked private
and `UNLICENSED`; do not vendor third-party implementation code or publish a
package until licensing is explicitly settled.
