// api/ai-key.js — manage a user's own OpenRouter API key (bring-your-own-key).
//   action:"status"  -> { ok, hasKey, model }
//   action:"save"    -> validate the key against OpenRouter, then store it in Vault
//   action:"delete"  -> remove the stored key (fall back to the app's key)
//
// The server-only Vault RPCs use the verified user's ID. Responses never contain the key.

const { verifyUser, getIntegration, setIntegration, deleteIntegration } = require('./_supabase');
const { DEFAULT_OPENROUTER_MODEL } = require('./_ai');

// Cheap round-trip that confirms the key works and the chosen model is usable.
async function validateKey(apiKey, model) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'Strength Log' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) return { ok: false, error: 'That OpenRouter key was rejected. Check the key and try again.' };
    if (!response.ok || data.error) return { ok: false, error: 'OpenRouter rejected the key or model.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Could not reach OpenRouter to verify the key. Try again in a moment.' };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { action } = body || {};

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

  try {
    if (action === 'status') {
      const current = await getIntegration(user, 'openrouter');
      return res.status(200).json({ ok: true, hasKey: !!current?.secret, model: current?.meta?.model || DEFAULT_OPENROUTER_MODEL });
    }
    if (action === 'delete') {
      await deleteIntegration(user, 'openrouter');
      return res.status(200).json({ ok: true, hasKey: false, model: DEFAULT_OPENROUTER_MODEL });
    }
    if (action === 'save') {
      const key = String(body.key || '').trim();
      const model = String(body.model || '').trim() || DEFAULT_OPENROUTER_MODEL;
      if (!key.startsWith('sk-or-')) {
        return res.status(400).json({ ok: false, error: 'That does not look like an OpenRouter key (they start with "sk-or-").' });
      }
      const check = await validateKey(key, model);
      if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
      await setIntegration(user, 'openrouter', key, { model });
      return res.status(200).json({ ok: true, hasKey: true, model });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 30 };
