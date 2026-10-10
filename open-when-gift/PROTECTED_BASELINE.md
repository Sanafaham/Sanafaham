# OPEN WHEN — PROTECTED BASELINE

Status: OWNER-APPROVED CURRENT GOOD STATE  
Date locked: 2026-10-05 (storage/security and owner access updated 2026-10-10, owner-approved)  
Edition expansion approved: Daughter + Son launch batch

This file defines the settled behavior that future OPEN WHEN work must preserve unless the owner explicitly approves a change.

## Protected product behavior

- Creator page remains separate from recipient gift view.
- Receiver never sees creator/personalization controls.
- Launch product supports exactly two protected editions: **For My Daughter** and **For My Son**.
- Creator first chooses **My Daughter** or **My Son**, then enters recipient first name and sender name.
- Switching editions changes the recipient label, original 24-letter set, and final relationship wording without changing the shared engine.
- Each edition has exactly 24 built-in letters.
- The saved gift record persists the selected edition so recipient links cannot mix Daughter and Son content.
- Sender name is required.
- Personalization is optional.
- Personalization uses compact 24-row accordion navigation.
- Only one letter editor is open at a time.
- Untouched letters show **Original**.
- Edited letters show **Personalized**.
- **Reset to original** appears only for edited letters and restores the built-in copy.
- **Done personalizing** remains immediately accessible at the top of the personalization section and closes the editor.
- After Done personalizing, **Create my gift** is the clear next step.
- Creating a gift saves all 24 messages privately and produces a shareable gift-token link.
- WhatsApp, Messages, Email, and native Share remain available.
- Receiver gift loads the exact saved personalized copy.
- Opened-card state persists locally per gift.
- Receiver can return with **Back to my cards** to the previous card-grid scroll position.
- Home Screen guidance remains compact and available, including opening the link in Safari (iPhone) or Chrome (Android) first when it was opened inside another app.
- In the browser that created the gift, the original access link recovers it (sender preview and sharing controls) after refresh, closing Safari or reopening the link. It never creates a second gift.
- A forwarded creation link opened in any other browser shows only "This gift has already been created." It never reveals the gift link or the sender's letters.
- Share and creator text supplied by the buyer is rendered as plain text, never as HTML.
- No web-app manifest is added until it can preserve the gift token safely.

## Protected visual system

- All relationship editions share the final approved stationery system: warm raw-organic ivory paper, natural kraft envelopes, strong dark ink, and restrained muted green accents.
- No gender-coded pink Daughter skin or blue Son skin remains. Brown action/tag backgrounds are also retired; action/tag emphasis uses the approved muted green.
- The hero card is complete and fully visible, with a clearly recognizable raw-paper envelope and flap seam visibly peeking behind it.
- The **dragonfly** is the approved core motif and must use the detailed engraved/scientific treatment with visible wing veining and a long segmented body on hero, mini envelopes, and opened letters.
- The 24 recipient cards remain in the established two-column mobile grid and must visually read as real little envelopes using explicit top-flap and lower-fold line geometry, never scratch-like diagonal decoration.
- Daughter and Son still use distinct copy, but the same visual system.
- Opened letters use the same universal size and position and must look printed on warm raw-organic paper with visible tactile texture and strong dark readable ink.
- Opened letter is a fixed full-screen experience with the current bounded sheet geometry.
- All opened letters use the same layout.
- Top accent remains a thin refined neutral-gold line.
- Tiny OPEN WHEN mark, centered dragonfly divider, number, title, body, dragonfly footer, sender line, Back to my cards.
- Cormorant Garamond opened-letter typography remains.
- Title remains the luxury italic treatment.
- Border/shadow stay light and stationery-like rather than web-box heavy.

## Protected opening motion

- Opening animation must replay every time a card opens.
- The page/card flips **to the right**.
- The hinge is on the **right edge**.
- Safari/iPhone 3D animation support stays enabled.
- The final card uses the same replay protection.

## Protected storage/security

- Personalized gift data stays in the private Vercel Blob store.
- Blob token is server-side only via `BLOB_READ_WRITE_TOKEN`.
- Gift reads/writes remain private.
- Edition is validated server-side as only `daughter` or `son`.
- Exactly 24 messages are validated server-side.
- Gift endpoint remains no-store.
- Creator access is denied without a valid server-issued one-use access token.
- Raw access tokens are never stored; only SHA-256 token hashes are persisted privately.
- Each access entitlement has one fixed gift ID assigned at issuance; every gift save targets `gifts/<giftId>.json`, so one entitlement can never produce more than one gift.
- Entitlement state changes use Vercel Blob's documented ETag conditional writes (`ifMatch`): unused → creating (time-limited claim) → used, and unused → revoked. Separate Blob writes are never treated as a transaction.
- An entitlement becomes `used` only after its gift exists. A crashed or interrupted save is recovered automatically after the claim expires; paid access is never consumed without a gift.
- The gift save is bounded by the claim and uses `allowOverwrite: false` as a secondary guard.
- Used, invalid, copied, replayed, revoked or concurrently submitted access links cannot authorize another gift.
- Buyer recovery is device-bound: the access check gives the browser a random recovery key in an `HttpOnly; Secure; SameSite=Strict; Path=/api` cookie, the entitlement stores only its SHA-256 hash when the gift is created, and a used link reveals its gift ID only when that key is presented. Lost-device recovery goes through the owner history.
- Gift recipient links remain independent of creator access tokens and continue to load by opaque gift ID through the unchanged `GET /api/gifts?id=` API.
- The current page checks access with `POST /api/access` (token in the request body, not the URL). `GET /api/access?token=` keeps its old contract for pages loaded before this release.
- Pages send no referrer to third parties (`Referrer-Policy: no-referrer`; the owner page uses `same-origin` so its own form posts keep a valid Origin).

## Protected owner access

- The original `X-Open-When-Admin` secret-header issuance remains available until the owner page is fully verified in production.
- `/owner.html` is owner-only: plain HTML password form posted to `/api/admin/session`; page JavaScript never handles the password; no external scripts or fonts; not indexed.
- Owner login is disabled unless `OPEN_WHEN_ADMIN_SECRET` is at least 32 characters.
- Owner sessions are signed cookies (HMAC-SHA256, key derived from the secret), 24-hour expiry, `HttpOnly; Secure; SameSite=Strict; Path=/api/admin`.
- Every owner request must be same-origin (Origin, or Fetch Metadata when Origin is absent or `null`); owner JSON calls also require `X-Open-When-Owner: 1`.
- Login attempts are rate limited (5 per 15 minutes per IP, 30 per hour overall) with counters in private Blob storage, reserved before the password is checked and failing closed.
- Owner history shows issue dates, optional order references, statuses and recipient gift links. It never shows raw access tokens or letter contents.
- Owner revocation applies to unused links only; revoked links never authorize gift creation.
- Preview deployments refuse the production Blob store when `OPEN_WHEN_PRODUCTION_STORE_ID` is set. Real-storage tests run only against a separate test store identified by `OPEN_WHEN_TEST_STORE_ID`; production credentials are never given to GitHub Actions or Preview.

## Engineering rule

Before any future OPEN WHEN feature is treated as complete:

1. Read this baseline.
2. Run `npm test` in `open-when-gift` (protected baseline guard, logic tests and endpoint tests). Run `npm run test:real-storage` against the isolated test store before release.
3. Do not weaken or update these protections merely to make a failing change pass.
4. If an intentional product decision changes a protected behavior, update the baseline only after explicit owner approval.
5. Verify the Vercel production deployment is READY.
6. Re-test the touched journey without changing unrelated settled behavior.

The automated guard lives at `open-when-gift/scripts/protect.mjs`, tests live in `open-when-gift/tests/`, and the GitHub workflow is `.github/workflows/open-when-protect.yml`. Browser checks: `npm i --no-save playwright && node tests/e2e/ui.e2e.mjs` (local, in-memory storage only).
