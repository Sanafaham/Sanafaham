# Open When production engineering

Read [PROTECTED_BASELINE.md](PROTECTED_BASELINE.md) before changing this application. Treat its customer journeys, copy, and design as release requirements.

- Never modify or delete real customer gifts, drafts, or entitlements without explicit owner approval. Test with synthetic fixtures and mocks. Never make live purchases or use real customer data in tests.
- Changes affecting payments, licensing, storage, or redemption require a documented impact analysis and regression coverage, including compatibility with existing purchases, drafts, gifts, and recipient links. Never rotate the redemption secret without an owner-approved migration strategy that preserves purchase identity.
- Keep all protected checks and the PR #7 compression regression. Never weaken a check to make a change pass. Obtain explicit owner approval for any intended change to protected behavior or approved letter copy.
- Before merging, run `npm test` with Node.js 24 in `open-when-gift/`. Require a passing GitHub Actions `protected-behaviors` check for the exact PR head. Release from `main` through the Git-connected Vercel build, whose build command also runs the protected checks. Never merge or deploy if a protected check fails or is missing. Do not bypass checks, promote unchecked builds, or use prebuilt uploads to bypass the release check.
- For an application release, verify the merged SHA and `READY` status at the public production alias. Use read-only or unauthenticated smoke checks that avoid real customer records. Record the tests and deployment evidence. Report a fix only when the evidence supports it, and distinguish automated, synthetic, and owner verification.

These workflow requirements apply even if repository or deployment permissions allow a bypass. Report any missing platform enforcement before treating it as enabled.
