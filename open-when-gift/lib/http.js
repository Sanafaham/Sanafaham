// Small request helpers shared by the OPEN WHEN API functions.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let text = '';
  if (typeof req.body === 'string') text = req.body;
  else if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8');
  else if (req.readable) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200_000) break;
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text) return {};
  const type = String((req.headers && req.headers['content-type']) || '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return {}; }
}

export function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
