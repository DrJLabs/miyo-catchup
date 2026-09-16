# Tests

`repository.test.mjs` covers scaffold validation only. Run it with `npm test`.
It uses repository files and temporary synthetic directories, never live data.

As implementation begins, add the plan's AC01–AC16 suites under the flat
`*.test.mjs` layout. Browser/live-import qualification must remain separately
authorized and must not execute as part of default CI. See
[fixture policy](fixtures/README.md).
