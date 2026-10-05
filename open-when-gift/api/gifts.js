import { get, put } from '@vercel/blob';

const MAX_TEXT = 4000;
const MAX_NAME = 40;

function safeText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'Gift storage is not configured.' });

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const id = safeText(body.id, 120).replace(/[^a-zA-Z0-9_-]/g, '');
      const edition = body.edition === 'son' ? 'son' : (body.edition === 'daughter' ? 'daughter' : '');
      const recipient = safeText(body.recipient, MAX_NAME);
      const sender = safeText(body.sender, MAX_NAME);
      const messages = Array.isArray(body.messages)
        ? body.messages.slice(0, 24).map(v => safeText(v, MAX_TEXT))
        : [];

      if (!id || !edition || !recipient || !sender || messages.length !== 24 || messages.some(v => !v)) {
        return res.status(400).json({ error: 'Invalid gift data.' });
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

      await put('gifts/' + id + '.json', JSON.stringify(gift), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        token
      });

      return res.status(201).json({ ok: true, id });
    } catch (error) {
      console.error('gift-save-failed', error);
      return res.status(500).json({ error: 'Could not save this gift.' });
    }
  }

  if (req.method === 'GET') {
    try {
      const id = safeText(req.query?.id, 120).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return res.status(400).json({ error: 'Missing gift id.' });

      const result = await get('gifts/' + id + '.json', {
        access: 'private',
        token,
        useCache: false
      });

      if (!result || result.statusCode !== 200) {
        return res.status(404).json({ error: 'Gift not found.' });
      }

      const text = await new Response(result.stream).text();
      const gift = JSON.parse(text);
      return res.status(200).json(gift);
    } catch (error) {
      console.error('gift-load-failed', error);
      return res.status(500).json({ error: 'Could not load this gift.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
}