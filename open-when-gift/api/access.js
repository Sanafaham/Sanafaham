import { get } from '@vercel/blob';
import crypto from 'node:crypto';

const MAX_ACCESS_TOKEN = 160;

function cleanAccessToken(value) {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_ACCESS_TOKEN).replace(/[^a-zA-Z0-9_-]/g, '')
    : '';
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return res.status(500).json({ error: 'Gift storage is not configured.' });

  try {
    const accessToken = cleanAccessToken(req.query?.token);
    if (!accessToken) return res.status(400).json({ error: 'Missing access token.' });

    const hash = tokenHash(accessToken);
    const result = await get('entitlements/' + hash + '.json', {
      access: 'private',
      token: blobToken,
      useCache: false
    });
    if (!result || result.statusCode !== 200) {
      return res.status(403).json({ valid: false, error: 'This access link is not valid.' });
    }

    const text = await new Response(result.stream).text();
    const entitlement = JSON.parse(text);
    if (entitlement.version !== 1 || entitlement.tokenHash !== hash || entitlement.status !== 'unused') {
      return res.status(409).json({ valid: false, error: 'This access link has already been used.' });
    }

    return res.status(200).json({ valid: true });
  } catch (error) {
    console.error('access-check-failed', error);
    return res.status(500).json({ error: 'Could not verify this access link.' });
  }
}
