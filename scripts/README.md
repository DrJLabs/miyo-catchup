# Repository checks

`check-repository.mjs` validates required scaffold files, package metadata,
repository-contained Markdown links and balanced code fences. It does not use
the network or inspect user/browser/Miyo state.

Run `npm run check`. This is a structural check, not a comprehensive security
scanner or runtime qualification. Perform a separate staged-diff/secret review
before public publication.
