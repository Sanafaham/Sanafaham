import { get, put } from '@vercel/blob';
import crypto from 'node:crypto';

/*
 * Gumroad purchase -> one-use creator access.
 *
 * The buyer pastes the license key Gumroad gives them. We verify it with Gumroad's
 * license API on the server, then map it to exactly ONE entitlement in the existing
 * entitlement store (the same records /api/access and /api/gifts already use).
 *
 * The access token is derived from the Gumroad sale id with an HMAC, so:
 *  - the same purchase (Gumroad sale id) always maps to the same token (safe to retry, no duplicates),
 *  - the raw token is never stored (only its SHA-256 hash, as before),
 *  - nobody can forge a token without the server secret.
 */

const GUMROAD_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
const MAX_LICENSE = 64;

export function cleanLicenseKey(value) {
  return typeof value === 'string'
    ? value.trim().toUpperCase().slice(0, MAX_LICENSE).replace(/[^A-Z0-9-]/g, '')
    : '';
}

// Keyed on Gumroad's sale id, not the key text, so any spelling of the same key
// that Gumroad accepts still maps to the same single entitlement.
export function deriveAccessToken(secret, saleId) {
  return crypto.createHmac('sha256', secret).update('gumroad-sale:v1:' + saleId).digest('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createRedeemHandler({ blob, fetchImpl, env }) {
  async function readEntitlement(pathname, token) {
    const result = await blob.get(pathname, { access: 'private', token, useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  }

  async function verifyWithGumroad(productId, licenseKey) {
    const body = new URLSearchParams({
      product_id: productId,
      license_key: licenseKey,
      increment_uses_count: 'false'
    });
    const r = await fetchImpl(GUMROAD_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const blobToken = env.BLOB_READ_WRITE_TOKEN;
    const productId = env.GUMROAD_PRODUCT_ID;
    const secret = env.OPEN_WHEN_REDEEM_SECRET;
    if (!blobToken || !productId || !secret) {
      return res.status(500).json({ error: 'Purchase checking is not configured yet.' });
    }

    const licenseKey = cleanLicenseKey((req.body || {}).licenseKey);
    if (licenseKey.length < 8) {
      return res.status(400).json({ error: 'Please paste the license key from your Gumroad receipt.' });
    }

    let verified;
    try {
      verified = await verifyWithGumroad(productId, licenseKey);
    } catch (error) {
      console.error('gumroad-verify-unreachable', error);
      return res.status(502).json({ error: 'I could not reach Gumroad to check your purchase. Please try again in a minute.' });
    }

    if (verified.status >= 500 || verified.status === 429) {
      return res.status(502).json({ error: 'I could not reach Gumroad to check your purchase. Please try again in a minute.' });
    }

    const purchase = verified.data && verified.data.purchase;
    if (!verified.ok || verified.data.success !== true || !purchase) {
      return res.status(403).json({ error: 'This license key is not valid for Open When.' });
    }
    if (purchase.product_id !== productId) {
      return res.status(403).json({ error: 'This license key is not valid for Open When.' });
    }
    const saleId = typeof purchase.id === 'string' ? purchase.id.trim().slice(0, 120) : '';
    if (!saleId) {
      return res.status(403).json({ error: 'This license key is not valid for Open When.' });
    }
    if (purchase.refunded || purchase.chargebacked || purchase.disputed) {
      return res.status(403).json({ error: 'This purchase was refunded or disputed, so it cannot create a gift.' });
    }

    const accessToken = deriveAccessToken(secret, saleId);
    const hash = sha256(accessToken);
    const entitlementPath = 'entitlements/' + hash + '.json';

    try {
      let entitlement = await readEntitlement(entitlementPath, blobToken);

      if (!entitlement) {
        const fresh = {
          version: 1,
          tokenHash: hash,
          status: 'unused',
          createdAt: new Date().toISOString(),
          usedAt: null,
          giftId: crypto.randomUUID(),
          source: 'gumroad',
          purchaseId: saleId
        };
        try {
          // No-overwrite create: if two redeem requests race, only one record wins.
          await blob.put(entitlementPath, JSON.stringify(fresh), {
            access: 'private',
            contentType: 'application/json',
            addRandomSuffix: false,
            allowOverwrite: false,
            token: blobToken
          });
          entitlement = fresh;
        } catch (error) {
          entitlement = await readEntitlement(entitlementPath, blobToken);
          if (!entitlement) throw error;
        }
      }

      if (entitlement.version !== 1 || entitlement.tokenHash !== hash) {
        return res.status(500).json({ error: 'This purchase could not be matched. Please reply to your receipt and I will fix it.' });
      }

      if (entitlement.status !== 'unused') {
        if (entitlement.status === 'used' && /^[a-zA-Z0-9_-]{1,120}$/.test(entitlement.giftId || '')) {
          const gift = await blob.get('gifts/' + entitlement.giftId + '.json', {
            access: 'private',
            token: blobToken,
            useCache: false
          });
          if (gift?.statusCode === 200) {
            await gift.stream?.cancel();
            return res.status(409).json({
              used: true,
              error: 'This purchase has already been used to create a gift.',
              giftPath: '/?gift=' + encodeURIComponent(entitlement.giftId)
            });
          }
        }
        return res.status(409).json({
          used: true,
          error: 'Your gift is not available yet. Please try again in a moment or reply to your receipt if this continues.'
        });
      }

      return res.status(200).json({
        ok: true,
        accessPath: '/?access=' + encodeURIComponent(accessToken)
      });
    } catch (error) {
      console.error('redeem-failed', error);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

export default createRedeemHandler({
  blob: { get, put },
  fetchImpl: (...args) => fetch(...args),
  env: process.env
});
