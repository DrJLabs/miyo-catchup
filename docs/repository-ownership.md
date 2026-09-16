# Repository ownership and migration

`DrJLabs/miyo-catchup` is the canonical source repository for the custom extension,
native host, local worker, contracts, tests, release/install templates and
[implementation plan](implementation-plan.md).

The initial plan was transferred from an operator-maintenance workspace as a
public-safe adaptation of its v2 specification. Requirement IDs R01–R16,
invariants I01–I08, tasks T01–T10 and acceptance cases AC01–AC16 are preserved.
Source-root references and repository setup authority were updated; private
operational inventories were replaced with [design evidence](design-evidence.md).

The operator workspace retains the original v1/v2 drafts as historical records,
recovery runbooks, machine-specific deployment notes and independent log-maintenance
tooling. Its pointer identifies this plan as authoritative for future service
work. Do not maintain two editable copies of the service specification.

Runtime names remain `miyo-chatgpt-catchup` as specified in the plan; the GitHub
repository's shorter name does not authorize renaming or migrating existing
private state. Prior recovery directories are not source inputs, test fixtures,
or cleanup targets. Nothing from that private state was copied here.

## Bootstrap boundary

The initial commit establishes documentation, reserved component directories,
offline repository checks and CI. It does not implement the browser collector,
worker, database schema, native registration, installer or systemd units.
Repository publication is not service activation or live-data authorization.

No distribution license is selected by the bootstrap. Future third-party code
reuse and package distribution require a separate licensing decision.
