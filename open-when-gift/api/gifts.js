import { get } from '@vercel/blob';
import { storeFromEnv } from '../lib/store.js';
import { createGift, cleanAccessToken } from '../lib/entitlements.js';
import { readBody, baseHeaders } from '../lib/http.js';

const MAX_TEXT = 4000;
const MAX_NAME = 40;
const MAX_ID = 120;

function safeText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanId(value) {
  return safeText(value, MAX_ID).replace(/[^a-zA-Z0-9_-]/g, '');
}

async function readPrivateJson(pathname, token) {
  const result = await get(pathname, { access: 'private', token, useCache: false });
  if (!result || result.statusCode !== 200) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

export function makeGiftsHandler({ getStore = storeFromEnv, readGift = readPrivateJson, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    baseHeaders(res);

    const token = process.env.BLOB_READ_WRITE_TOKEN;

    if (req.method === 'POST') {
      let store;
      try { store = getStore(); } catch { return res.status(500).json({ error: 'Gift storage is not configured.' }); }
      try {
        const body = await readBody(req);
        const requestedId = cleanId(body.id);
        const accessToken = cleanAccessToken(body.accessToken);
        const edition = body.edition === 'son' ? 'son' : (body.edition === 'daughter' ? 'daughter' : '');
        const recipient = safeText(body.recipient, MAX_NAME);
        const sender = safeText(body.sender, MAX_NAME);
        const messages = Array.isArray(body.messages)
          ? body.messages.slice(0, 24).map(v => safeText(v, MAX_TEXT))
          : [];

        if (!requestedId || !accessToken || !edition || !recipient || !sender || messages.length !== 24 || messages.some(v => !v)) {
          return res.status(400).json({ error: 'Invalid gift data.' });
        }

        // One gift per access entitlement; the gift ID comes from the entitlement, never the browser.
        const result = await createGift(store, { rawToken: accessToken, gift: { edition, recipient, sender, messages }, now });
        return res.status(result.status).json(result.body);
      } catch (error) {
        console.error('gift-save-failed', error && error.name);
        return res.status(500).json({ error: 'Could not save this gift.' });
      }
    }

    if (req.method === 'GET') {
      if (!token) return res.status(500).json({ error: 'Gift storage is not configured.' });
      try {
        const id = cleanId(req.query?.id);
        if (!id) return res.status(400).json({ error: 'Missing gift id.' });

        const gift = await readGift('gifts/' + id + '.json', token);
        if (!gift) return res.status(404).json({ error: 'Gift not found.' });
        return res.status(200).json(gift);
      } catch (error) {
        console.error('gift-load-failed', error && error.name);
        return res.status(500).json({ error: 'Could not load this gift.' });
      }
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  };
}

export default makeGiftsHandler();
