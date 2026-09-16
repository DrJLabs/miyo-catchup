# miyo-catchup

Daily and on-demand ChatGPT catch-up into native Miyo Chats, with Miyo's native
ChatGPT sync left disconnected.

**Status: specification and project scaffold.** There is no working extension,
collector, CLI, installer, or background service yet. Nothing in this repository
currently contacts ChatGPT or changes Miyo data.

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

Use Node **22.23.2** (pinned in `.nvmrc`). The scaffold has no package dependencies
and needs no `npm install`:

```bash
npm run check
npm test
```

These validate the repository structure, documentation links, and scaffold
metadata. They do **not** validate authenticated capture, native import, Chrome
permissions, SQLite crash durability, or production scheduling. CI runs the same
offline checks on public source only.

## Layout

```text
extension/       Chrome extension boundary (reserved)
src/             Local worker, CLI and bridge boundary (reserved)
adapters/        Version-qualified integration adapters (reserved)
schemas/         Protocol/configuration/receipt schemas (reserved)
tests/           Scaffold tests and synthetic-fixture policy
systemd/         Future user service/timer templates (reserved)
install/         Future explicit installation helpers (reserved)
scripts/         Working repository validation tools
docs/            Canonical specification and supporting documentation
```

Each reserved directory has an ownership README rather than a misleading dummy
implementation. The first runtime task is T01 in the implementation plan,
followed by the smallest authorized T02 browser-to-local proof.

## Licensing

A distribution license has not been selected. `package.json` is marked private
and `UNLICENSED`; do not vendor third-party implementation code or publish a
package until licensing is explicitly settled.
