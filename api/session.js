const {
  clearSessionCookie, sessionConfigured, sessionCookie, sessionUser, verifyGoogleIdToken,
} = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    return res.status(200).json({ ok: true });
  }
  if (!sessionConfigured()) return res.status(503).json({ ok: false, configured: false });

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const user = await verifyGoogleIdToken(body?.idToken);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid Google sign-in.' });
    res.setHeader('Set-Cookie', sessionCookie(user, req));
    return res.status(200).json({ ok: true, user });
  }

  if (req.method === 'GET') {
    const user = sessionUser(req);
    if (!user) {
      res.setHeader('Set-Cookie', clearSessionCookie(req));
      return res.status(401).json({ ok: false, authenticated: false });
    }
    // Sliding expiry: opening the app renews the seven-day inactivity window.
    res.setHeader('Set-Cookie', sessionCookie(user, req));
    return res.status(200).json({ ok: true, authenticated: true, user });
  }

  return res.status(405).json({ ok: false, error: 'Unsupported method' });
};
