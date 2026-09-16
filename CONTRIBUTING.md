# Contributing

This repository contains offline T01 foundations and source-only T02 probe
modules, not a released service. Read [AGENTS.md](AGENTS.md) and the
[implementation plan](docs/implementation-plan.md) before making changes.

1. Identify the task and applicable requirement/acceptance IDs.
2. Keep the change bounded; preserve unrelated work and private operational data.
3. Use Node 22.23.2 and built-in testing/runtime facilities where adequate.
4. Add synthetic positive and negative cases when implementing behavior. Tests
   must not discover credentials, home directories, or live local services.
5. Run `npm run check`, `npm test`, and `git diff --check`.
6. Report exact results and unrun qualification layers. Passing offline tests
   does not establish that the extension or importer works.

Authenticated browser tests, native-host registration, live archive writes,
installation and daily activation each require the corresponding scope in the
plan. Do not induce real rate limiting to test error handling.

Changes to identity boundaries, permissions, request policy, state schemas,
rendering or verification must update the canonical plan and invalidate affected
qualification evidence. Do not change acceptance criteria simply to match a bug.

Public issues and pull requests must contain synthetic examples only. Check the
staged diff and scan for secrets before publication. Follow [SECURITY.md](SECURITY.md)
for sensitive findings; no chat exports, account IDs or raw logs in public issues.

The initial repository has no selected distribution license and no approved
third-party dependencies. Resolve those choices explicitly before importing code.
