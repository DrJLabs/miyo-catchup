# Repository checks

`check-repository.mjs` validates required scaffold files, package metadata,
repository-contained Markdown links, balanced code fences, complete plan sections
and absence of captured tool-truncation markers. It does not use
the network or inspect user/browser/Miyo state.

Run `npm run check`. This is a structural check, not a comprehensive security
scanner or runtime qualification. Perform a separate staged-diff/secret review
before public publication.
