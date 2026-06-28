const {
  fetchWeights, loadTokenByWithingsUserId, mergeWeightsIntoCloud, saveToken, tokenRequest,
  normalizeToken, verifyWebhookSecret,
} = require('./_withings');

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  return Object.fromEntries(new URLSearchParams(String(body || '')).entries());
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!verifyWebhookSecret(req.query?.token)) return res.status(401).json({ ok: false });
  const body = parseBody(req.body);
  if (String(body.appli) !== '1' || !body.userid) return res.status(200).json({ ok: true, ignored: true });
  try {
    const match = await loadTokenByWithingsUserId(body.userid);
    if (!match) return res.status(200).json({ ok: true, ignored: true });
    let token = match.token;
    if (token.expiresAt <= Date.now() + 60000) {
      const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
      token = normalizeToken(refreshed, token);
      await saveToken(match.sub, token);
    }
    const startDate = Number(body.startdate) || Math.floor(Date.now() / 1000) - 2 * 86400;
    const endDate = Number(body.enddate) || Math.floor(Date.now() / 1000);
    const weights = await fetchWeights(token.accessToken, { startDate, endDate });
    const result = await mergeWeightsIntoCloud(match.sub, weights);
    return res.status(200).json({ ok: true, merged: result.merged });
  } catch (e) {
    console.error('Withings webhook failed:', e);
    return res.status(500).json({ ok: false });
  }
};

module.exports.config = { maxDuration: 60 };
