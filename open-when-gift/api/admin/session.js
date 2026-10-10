import { storeFromEnv } from '../../lib/store.js';
import { readBody, baseHeaders } from '../../lib/http.js';
import {
  adminSecret, secretIsStrong, timingSafeEqualText, isSameOrigin,
  createSession, sessionCookie, clearedSessionCookie, reserveLoginAttempt
} from '../../lib/owner-auth.js';

// Owner login / logout. Receives a plain HTML form post from /owner.html, so the password is
// never handled by page JavaScript. Always answers with a redirect back to the owner page.
export function makeSessionHandler({ getStore = storeFromEnv, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    baseHeaders(res);
    const back = (query = '', cookie) => {
      if (cookie) res.setHeader('Set-Cookie', cookie);
      res.setHeader('Location', '/owner.html' + query);
      return res.status(303).end();
    };

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!isSameOrigin(req)) return back('?login=failed');

    const body = await readBody(req);
    if (body.action === 'logout') return back('', clearedSessionCookie());

    const secret = adminSecret();
    if (!secretIsStrong(secret)) return back('?login=disabled');

    try {
      const slot = await reserveLoginAttempt(getStore(), req, secret, now());
      if (slot !== 'ok') return back('?login=wait');
    } catch (error) {
      console.error('owner-login-guard-failed', error && error.name);
      return back('?login=wait');
    }

    const password = typeof body.password === 'string' ? body.password.slice(0, 512) : '';
    if (!timingSafeEqualText(password, secret)) return back('?login=failed');

    return back('', sessionCookie(createSession(secret, now())));
  };
}

export default makeSessionHandler();
