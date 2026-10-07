import { put } from '@vercel/blob';
import crypto from 'node:crypto';

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const adminSecret = process.env.OPEN_WHEN_ADMIN_SECRET;
  if (!blobToken || !adminSecret) return res.status(500).json({ error: 'Access issuing is not configured.' });

  const supplied = req.headers['x-open-when-admin'];
  if (!timingSafeEqualText(supplied, adminSecret)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const createdAt = new Date().toISOString();
    const entitlement = {
      version: 1,
      tokenHash: hash,
      status: 'unused',
      createdAt,
      usedAt: null,
      giftId: null
    };

    await put('entitlements/' + hash + '.json', JSON.stringify(entitlement), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      token: blobToken
    });

    return res.status(201).json({
      ok: true,
      accessToken: rawToken,
      accessPath: '/?access=' + encodeURIComponent(rawToken)
    });
  } catch (error) {
    console.error('access-issue-failed', error);
    return res.status(500).json({ error: 'Could not issue an access link.' });
  }
}
