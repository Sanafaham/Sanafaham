# OPEN WHEN — PROTECTED BASELINE

Status: OWNER-APPROVED CURRENT GOOD STATE  
Date locked: 2026-10-05  
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
- Home Screen guidance remains compact and available.
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

## Engineering rule

Before any future OPEN WHEN feature is treated as complete:

1. Read this baseline.
2. Run `npm test` in `open-when-gift`.
3. Do not weaken or update these protections merely to make a failing change pass.
4. If an intentional product decision changes a protected behavior, update the baseline only after explicit owner approval.
5. Verify the Vercel production deployment is READY.
6. Re-test the touched journey without changing unrelated settled behavior.

The automated guard lives at `open-when-gift/scripts/protect.mjs` and the GitHub workflow is `.github/workflows/open-when-protect.yml`.
