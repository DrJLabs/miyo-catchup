# miyo-catchup

Daily and on-demand ChatGPT catch-up into native Miyo Chats, with Miyo's native
ChatGPT sync left disconnected.

**Status: T01 offline foundations.** Versioned contracts, bounded native framing,
private-path validation and SQLite/process-ownership qualification are
implemented and tested. There is no working extension, collector, CLI, installer or
background service yet. Nothing in this repository currently contacts ChatGPT
or changes Miyo data.

This is an independent integration project, not an official Miyo or OpenAI product.

## Intended approach

- A small custom Chrome extension uses an existing signed-in ChatGPT profile.
- A native-message bridge transfers bounded conversation data, never credentials.
- A local worker owns pacing, cooldowns, checkpoints and recoverable imports.
- Miyo's existing watcher owns native indexing; the worker verifies the result.
- A user-level timer eventually requests daily work. Closed-browser work waits
  for that browser to return; it does not launch an alternate profile.

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
extension/       Chrome extension boundary (reserved)
src/             Offline contracts, framing, safe paths and runtime primitives
adapters/        Version-qualified integration adapters (reserved)
schemas/         Version 1 protocol/configuration/status/receipt contracts
tests/           Offline contract and runtime tests; synthetic fixtures only
systemd/         Future user service/timer templates (reserved)
install/         Future explicit installation helpers (reserved)
scripts/         Working repository validation tools
docs/            Canonical specification and supporting documentation
```

Reserved runtime directories retain ownership READMEs. T01 is the first
implementation stage; the next gate is T02's explicitly paired, one-conversation
browser-to-local proof. The full coordinator/importer follows that proof.

## Licensing

A distribution license has not been selected. `package.json` is marked private
and `UNLICENSED`; do not vendor third-party implementation code or publish a
package until licensing is explicitly settled.
