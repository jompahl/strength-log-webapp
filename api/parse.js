// api/parse.js — calls Claude (Anthropic API) to turn free text or a food photo
// into structured data the app can store. The Anthropic key stays server-side.
//
// Env vars (Vercel):
//   ANTHROPIC_API_KEY   your Anthropic API key (sk-ant-...)
//   GOOGLE_CLIENT_ID    (reused) to verify the user's sign-in token
//
// We still verify the Google ID token so only signed-in users can spend your API budget.

const { OAuth2Client } = require('google-auth-library');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const authClient = new OAuth2Client(CLIENT_ID);

async function verifyUser(idToken) {
  try {
    const ticket = await authClient.verifyIdToken({ idToken, audience: CLIENT_ID });
    const p = ticket.getPayload();
    return { sub: p.sub, email: p.email };
  } catch (e) { return null; }
}

const SYSTEM = `You convert a user's fitness log input into structured JSON for a tracker.
The input is either a description of food eaten, or a strength/cardio workout, given as text and/or an image of a meal.

Return ONLY a JSON object, no markdown, no prose. Pick ONE shape based on the input:

FOOD (a meal or food items):
{"kind":"food","items":[{"name":"short name","kcal":<int>,"p":<grams protein int>,"c":<grams carbs int>,"fat":<grams fat int>}]}
- Estimate realistic values. One entry per distinct item, or a single combined entry for a mixed plate.
- Be honest and slightly conservative; portion sizes from a photo are approximate.

STRENGTH workout:
{"kind":"strength","type":"Push|Pull|Legs|Other","exercises":[{"name":"Exercise Name","sets":[{"reps":<int>,"weight":<kg number, 0 for bodyweight, negative for assisted>}]}]}
- Infer the type (Push/Pull/Legs) from the exercises. Use proper capitalized exercise names.

CARDIO workout:
{"kind":"cardio","activity":"Run|Walk|Cycle|Row|Swim","distance_km":<number or null>,"duration_min":<number or null>,"calories":<int or null>}

If you truly cannot tell, return {"kind":"unknown"}.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ ok: false, error: 'Server missing ANTHROPIC_API_KEY.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { idToken, text, image, mediaType } = body || {};

  const user = await verifyUser(idToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

  // Build the Claude message content (text and/or image)
  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } });
  }
  content.push({ type: 'text', text: (text && text.trim()) ? text.trim() : 'Estimate the food in this image.' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ ok: false, error: data.error.message || 'Claude API error' });

    const textOut = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let parsed;
    try {
      const clean = textOut.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(200).json({ ok: false, error: 'Could not understand that. Try rephrasing.', raw: textOut });
    }
    return res.status(200).json({ ok: true, result: parsed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
