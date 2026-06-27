const crypto = require('node:crypto');
const {
  OURA_CLIENT_ID, OURA_REDIRECT_URI, cookieValue, deleteToken, fetchDailyActivity, isConfigured,
  loadToken, normalizeToken, saveToken, signState, tokenRequest, usableToken, verifyGoogleUser, verifyState,
} = require('./_oura');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const origin = appOrigin(req);
    if (!isConfigured()) return redirect(res, `${origin}/?oura=error&message=not_configured`);
    const state = verifyState(req.query?.state);
    const nonce = cookieValue(req, 'oura_oauth_nonce');
    res.setHeader('Set-Cookie', 'oura_oauth_nonce=; HttpOnly; SameSite=Lax; Path=/api/oura; Max-Age=0');
    if (!state || !nonce || nonce !== state.nonce) return redirect(res, `${origin}/?oura=error&message=invalid_state`);
    if (req.query?.error) return redirect(res, `${origin}/?oura=error&message=access_denied`);
    if (!req.query?.code) return redirect(res, `${origin}/?oura=error&message=missing_code`);
    try {
      const data = await tokenRequest({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: OURA_REDIRECT_URI });
      const token = normalizeToken({ ...data, scope: data.scope || req.query?.scope || '' });
      if (!String(token.scope).split(/[ ,]+/).includes('daily')) return redirect(res, `${origin}/?oura=error&message=daily_scope_required`);
      await saveToken(state.sub, token);
      return redirect(res, `${origin}/?oura=connected`);
    } catch (e) {
      return redirect(res, `${origin}/?oura=error&message=connection_failed`);
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Unsupported method' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const action = body?.action || 'status';
  if (action === 'status' && !isConfigured()) return res.status(200).json({ ok: true, configured: false, connected: false });
  if (!isConfigured()) return res.status(503).json({ ok: false, error: 'Oura sync is not configured yet.' });
  const user = await verifyGoogleUser(body?.idToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

  try {
    if (action === 'status') {
      const token = await loadToken(user.sub);
      return res.status(200).json({ ok: true, configured: true, connected: Boolean(token), connectedAt: token?.connectedAt || null });
    }
    if (action === 'connect') {
      const nonce = crypto.randomBytes(24).toString('base64url');
      const state = signState({ sub: user.sub, nonce, exp: Date.now() + 10 * 60 * 1000 });
      const secure = appOrigin(req).startsWith('https://') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `oura_oauth_nonce=${encodeURIComponent(nonce)}; HttpOnly; SameSite=Lax; Path=/api/oura; Max-Age=600${secure}`);
      const url = new URL('https://cloud.ouraring.com/oauth/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', OURA_CLIENT_ID);
      url.searchParams.set('redirect_uri', OURA_REDIRECT_URI);
      url.searchParams.set('scope', 'daily');
      url.searchParams.set('state', state);
      return res.status(200).json({ ok: true, url: url.toString() });
    }
    if (action === 'disconnect') {
      const token = await loadToken(user.sub);
      if (token?.accessToken) {
        try { await fetch(`https://api.ouraring.com/oauth/revoke?access_token=${encodeURIComponent(token.accessToken)}`); } catch (e) {}
      }
      await deleteToken(user.sub);
      return res.status(200).json({ ok: true, connected: false });
    }
    if (action === 'sync') {
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(body?.startDate || '') ? body.startDate : new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(body?.endDate || '') ? body.endDate : new Date().toISOString().slice(0, 10);
      const token = await usableToken(user.sub);
      if (!token) return res.status(409).json({ ok: false, error: 'Connect Oura first.' });
      const rows = await fetchDailyActivity(token.accessToken, startDate, endDate);
      const daily = rows.map(row => ({
        date: row.day,
        activeCalories: Number(row.active_calories) || 0,
        totalCalories: Number(row.total_calories) || 0,
        steps: Number(row.steps) || 0,
        score: Number(row.score) || null,
        syncedAt: new Date().toISOString(),
      })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.totalCalories > 0);
      return res.status(200).json({ ok: true, daily });
    }
    return res.status(400).json({ ok: false, error: 'Unknown Oura action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 60 };
