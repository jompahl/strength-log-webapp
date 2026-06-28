const crypto = require('node:crypto');
const {
  WITHINGS_CLIENT_ID, WITHINGS_REDIRECT_URI, cookieValue, deleteToken, fetchWeights, isConfigured,
  loadToken, normalizeToken, notificationRequest, saveToken, signState, tokenRequest, usableToken,
  verifyGoogleUser, verifyState, webhookUrl,
} = require('./_withings');

function appOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.end();
}

function appendCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  const cookies = current ? (Array.isArray(current) ? current : [current]) : [];
  res.setHeader('Set-Cookie', [...cookies, value]);
}

function errorRedirect(res, origin, message) {
  return redirect(res, `${origin}/?withings=error&message=${encodeURIComponent(message)}`);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'HEAD') return res.status(200).end();

  if (req.method === 'GET') {
    // Withings' dashboard probes registered URLs without OAuth parameters.
    if (!req.query?.code && !req.query?.state && !req.query?.error) return res.status(200).json({ ok: true });
    const origin = appOrigin(req);
    if (!isConfigured()) return errorRedirect(res, origin, 'not_configured');
    const state = verifyState(req.query?.state);
    const nonce = cookieValue(req, 'withings_oauth_nonce');
    appendCookie(res, 'withings_oauth_nonce=; HttpOnly; SameSite=Lax; Path=/api/withings; Max-Age=0');
    if (!state || (nonce && nonce !== state.nonce)) return errorRedirect(res, origin, 'invalid_state');
    if (req.query?.error) return errorRedirect(res, origin, 'access_denied');
    if (!req.query?.code) return errorRedirect(res, origin, 'missing_code');
    try {
      const data = await tokenRequest({
        grant_type: 'authorization_code', code: req.query.code, redirect_uri: WITHINGS_REDIRECT_URI,
      });
      const token = normalizeToken(data);
      await saveToken(state.sub, token);
      if (webhookUrl()) {
        try {
          await notificationRequest('subscribe', token.accessToken);
          token.webhookSubscribed = true;
          await saveToken(state.sub, token);
        } catch (e) { console.error('Withings webhook subscription failed:', e); }
      }
      return redirect(res, `${origin}/?withings=connected`);
    } catch (e) {
      console.error('Withings OAuth callback failed:', e);
      return errorRedirect(res, origin, 'connection_failed');
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Unsupported method' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const action = body?.action || 'status';
  if (action === 'status' && !isConfigured()) return res.status(200).json({ ok: true, configured: false, connected: false });
  if (!isConfigured()) return res.status(503).json({ ok: false, error: 'Withings sync is not configured yet.' });
  const user = await verifyGoogleUser(body?.idToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

  try {
    if (action === 'status') {
      const token = await loadToken(user.sub);
      return res.status(200).json({
        ok: true, configured: true, connected: Boolean(token), connectedAt: token?.connectedAt || null,
        webhookConfigured: Boolean(webhookUrl()), webhookSubscribed: Boolean(token?.webhookSubscribed),
      });
    }
    if (action === 'connect') {
      const nonce = crypto.randomBytes(24).toString('base64url');
      const state = signState({ sub: user.sub, nonce, exp: Date.now() + 10 * 60 * 1000 });
      const secure = appOrigin(req).startsWith('https://') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `withings_oauth_nonce=${encodeURIComponent(nonce)}; HttpOnly; SameSite=Lax; Path=/api/withings; Max-Age=600${secure}`);
      const url = new URL('https://account.withings.com/oauth2_user/authorize2');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', WITHINGS_CLIENT_ID);
      url.searchParams.set('redirect_uri', WITHINGS_REDIRECT_URI);
      url.searchParams.set('scope', 'user.metrics');
      url.searchParams.set('state', state);
      return res.status(200).json({ ok: true, url: url.toString() });
    }
    if (action === 'disconnect') {
      const storedToken = await loadToken(user.sub);
      let token = storedToken;
      try { token = await usableToken(user.sub); } catch (e) { /* local disconnect must still succeed */ }
      if (token?.accessToken && webhookUrl()) {
        try { await notificationRequest('revoke', token.accessToken); } catch (e) {}
      }
      await deleteToken(user.sub);
      return res.status(200).json({ ok: true, connected: false });
    }
    if (action === 'sync') {
      const token = await usableToken(user.sub);
      if (!token) return res.status(409).json({ ok: false, error: 'Connect Withings first.' });
      const now = Math.floor(Date.now() / 1000);
      const startDate = Number(body?.startDate) || now - 365 * 86400;
      const weights = await fetchWeights(token.accessToken, { startDate, endDate: now });
      return res.status(200).json({ ok: true, weights });
    }
    return res.status(400).json({ ok: false, error: 'Unknown Withings action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 60 };
