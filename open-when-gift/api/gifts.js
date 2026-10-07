import { get, put } from '@vercel/blob';
import crypto from 'node:crypto';

const MAX_TEXT = 4000;
const MAX_NAME = 40;
const MAX_ID = 120;
const MAX_ACCESS_TOKEN = 160;

function safeText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanId(value) {
  return safeText(value, MAX_ID).replace(/[^a-zA-Z0-9_-]/g, '');
}

function cleanAccessToken(value) {
  return safeText(value, MAX_ACCESS_TOKEN).replace(/[^a-zA-Z0-9_-]/g, '');
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readPrivateJson(pathname, token) {
  const result = await get(pathname, { access: 'private', token, useCache: false });
  if (!result || result.statusCode !== 200) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'Gift storage is not configured.' });

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const id = cleanId(body.id);
      const accessToken = cleanAccessToken(body.accessToken);
      const edition = body.edition === 'son' ? 'son' : (body.edition === 'daughter' ? 'daughter' : '');
      const recipient = safeText(body.recipient, MAX_NAME);
      const sender = safeText(body.sender, MAX_NAME);
      const messages = Array.isArray(body.messages)
        ? body.messages.slice(0, 24).map(v => safeText(v, MAX_TEXT))
        : [];

      if (!id || !accessToken || !edition || !recipient || !sender || messages.length !== 24 || messages.some(v => !v)) {
        return res.status(400).json({ error: 'Invalid gift data.' });
      }

      const hash = tokenHash(accessToken);
      const entitlementPath = 'entitlements/' + hash + '.json';
      const entitlement = await readPrivateJson(entitlementPath, token);

      if (!entitlement || entitlement.version !== 1 || entitlement.tokenHash !== hash) {
        return res.status(403).json({ error: 'This access link is not valid.' });
      }
      if (entitlement.status !== 'unused') {
        return res.status(409).json({ error: 'This access link has already been used.' });
      }

      const giftPath = 'gifts/' + id + '.json';
      const existingGift = await get(giftPath, { access: 'private', token, useCache: false });
      if (existingGift && existingGift.statusCode === 200) {
        return res.status(409).json({ error: 'Gift already exists.' });
      }

      const gift = {
        version: 1,
        edition,
        id,
        recipient,
        sender,
        messages,
        createdAt: new Date().toISOString()
      };

      /*
       * Consume the entitlement before publishing the gift. The entitlement record is
       * server-owned and never exposes the raw token. Vercel Blob's addRandomSuffix:false
       * gives this token one stable record. A second request sees status=used and is rejected.
       */
      const usedAt = new Date().toISOString();
      await put(entitlementPath, JSON.stringify({
        ...entitlement,
        status: 'used',
        usedAt,
        giftId: id
      }), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        token
      });

      try {
        await put(giftPath, JSON.stringify(gift), {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          token
        });
      } catch (error) {
        // Restore the entitlement if gift persistence fails so a paid buyer is not stranded.
        await put(entitlementPath, JSON.stringify({
          ...entitlement,
          status: 'unused',
          usedAt: null,
          giftId: null
        }), {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          token
        });
        throw error;
      }

      return res.status(201).json({ ok: true, id });
    } catch (error) {
      console.error('gift-save-failed', error);
      return res.status(500).json({ error: 'Could not save this gift.' });
    }
  }

  if (req.method === 'GET') {
    try {
      const id = cleanId(req.query?.id);
      if (!id) return res.status(400).json({ error: 'Missing gift id.' });

      const gift = await readPrivateJson('gifts/' + id + '.json', token);
      if (!gift) return res.status(404).json({ error: 'Gift not found.' });
      return res.status(200).json(gift);
    } catch (error) {
      console.error('gift-load-failed', error);
      return res.status(500).json({ error: 'Could not load this gift.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
}
