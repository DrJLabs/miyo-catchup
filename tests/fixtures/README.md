# Fixture policy

Only synthetic, deliberately constructed payloads belong here. No downloads,
chat exports, authentication responses, production database copies, real account
IDs or raw recovery receipts. Redaction is not assumed sufficient for publication.

Fixtures must explicitly inject roots, clocks and network/index responses. Tests
must fail rather than falling back to production resources.
