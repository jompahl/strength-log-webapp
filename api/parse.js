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
const MODEL = 'claude-sonnet-4-6';
const authClient = new OAuth2Client(CLIENT_ID);

async function verifyUser(idToken) {
  try {
    const ticket = await authClient.verifyIdToken({ idToken, audience: CLIENT_ID });
    const p = ticket.getPayload();
    return { sub: p.sub, email: p.email };
  } catch (e) { return null; }
}

const SYSTEM = `You are a fitness logging assistant AND a practical nutrition/training coach inside a tracker app.
Your in-app name is provided in the user's context and always starts with "Coach". Speak in a direct, friendly coaching voice.
The user sends a message (and sometimes a food photo), plus a summary of their training/weight HISTORY and a snapshot of their current day's numbers.

Decide what they want — they may be LOGGING something, ASKING for advice, or BOTH in one message.

Treat RECENT CONVERSATION as shared conversational memory for every request, not only profile setup. Resolve natural follow-ups such as "change that exercise", "make it shorter", "what about tomorrow?", or "I don't have that machine" from the plan or answer you gave earlier. When the user asks for a change, return the revised part or revised plan directly, preserving the parts they did not ask to change. Ask a clarifying question only when the intended reference genuinely cannot be determined from the recent turns.

Return ONLY a JSON object, no markdown fences, no prose outside the JSON. Use this shape:
{
  "log": <null, or one of the log objects below>,
  "reply": "<short coaching reply in plain language, or empty string if they only logged>"
}

LOG object options (set "log" to one of these, or null if nothing to log):
- Profile setup: {"kind":"profile","weight_kg":<num>,"height_cm":<int>,"age":<int>,"activity_level":"sedentary|light|moderate|very","target_weight_kg":<num>}
  Use this when the user is new and gives their starting stats/goals. Profile values may be spread across several turns: retain every value already present in RECENT CONVERSATION and combine it with the newest answer. Never ask again for a field they already answered. If any required field is still missing, set log to null and ask one brief, natural follow-up question for one or more missing fields. Return the complete Profile setup log as soon as all five values have been collected.
- Weigh-in: {"kind":"weight","kg":<num>,"date":"YYYY-MM-DD"}
  Outside new-user setup, a standalone body weight is a weigh-in, NOT profile setup. During new-user setup, treat a plain current-weight answer as a profile field; only create a weigh-in if the user clearly says they weighed themselves on a particular day. Preserve the specific day the user names; resolve relative dates such as "yesterday" from the local date supplied in context. If no day is named, use that local date.
- Food: {"kind":"food","items":[{"name":"short name","kcal":<int>,"p":<int>,"c":<int>,"fat":<int>}]}
- Strength: {"kind":"strength","type":"Push|Pull|Legs|Other","exercises":[{"name":"Name","sets":[{"reps":<int>,"weight":<kg, 0=bodyweight, negative=assisted>}]}]}
- Cardio: {"kind":"cardio","activity":"Run|Walk|Cycle|Row|Swim|Hike|Badminton|Padel|Tennis|Soccer|Skipping|Basketball|<other>","distance_km":<num|null>,"duration_min":<num|null>,"calories":<int|null>}
  For sports/activities without a meaningful distance (badminton, padel, soccer, skipping, etc.), set distance_km and pace to null and ESTIMATE calories from the activity + duration + the user's bodyweight if known. Capitalize the activity name.

REPLY guidance:
- Carry context forward across turns. Understand references like "that workout", "the second exercise", "replace it", and "instead" using RECENT CONVERSATION.
- When revising a workout or meal plan, keep the user's accepted constraints and unchanged items instead of inventing a completely new plan.
- Use the user's actual numbers from the context (protein gap, remaining calories, deficit) to give specific, actionable next steps.
- When relevant, reference their HISTORY: lift progression (e1RM trends), training frequency/balance, and weight trajectory. E.g. "your bench e1RM is up 8kg" or "your weight trend is -0.4kg/week, right on track."
- Keep it short and practical: concrete foods/amounts, simple swaps.
- Format replies for a small chat window. Prefer short paragraphs, blank lines, and bullets. Use **bold** labels sparingly, like **Today** or **Next workout**.
- When listing a workout, meal plan, or action plan, use bullet points or numbered steps instead of one dense paragraph.
- A light smiley is okay when it fits, but do not overdo it.
- Stay in the lane of general fitness and nutrition. Keep any suggested deficit sensible (not aggressive starvation). 
- Do NOT give medical advice, diagnose, or address eating-disorder territory; if a message suggests that, gently suggest a professional and keep it brief.
- If they only logged something with no question, "reply" can be a one-line confirmation or empty string.

If you cannot tell what they mean at all, return {"log":null,"reply":"<a brief clarifying question>"}.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ ok: false, error: 'Server missing ANTHROPIC_API_KEY.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { idToken, text, image, mediaType, context, history, conversation, localDate } = body || {};

  const user = await verifyUser(idToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

  // Build the Claude message content (text and/or image), prefixed with the snapshots
  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } });
  }
  let userText = '';
  if (localDate) { userText += `[User local date] ${localDate}\n\n`; }
  if (history) { userText += `${history}\n\n`; }
  if (context) { userText += `[Today's snapshot] ${context}\n\n`; }
  if (Array.isArray(conversation) && conversation.length) {
    const recent = conversation.slice(-10).map(turn => {
      const role = turn?.role === 'coach' ? 'Coach' : 'User';
      const value = String(turn?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      return value ? `${role}: ${value}` : '';
    }).filter(Boolean).join('\n');
    if (recent) userText += `[Recent conversation — use these earlier answers]\n${recent}\n\n`;
  }
  if (body?.onboarding) {
    userText += `[New-user setup] Collect current weight in kg, height in cm, age, activity level, and target weight in kg conversationally across turns. Combine the newest message with all answers in Recent conversation. Do not request answered fields again. When anything is missing, acknowledge what you learned and ask a short follow-up for only the missing information. Once all fields are known, return one complete Profile setup log.\n\n`;
  }
  if (body?.coachName) {
    userText += `[Coach identity] Reply as ${body.coachName}.\n\n`;
  }
  userText += (text && text.trim()) ? text.trim() : 'Estimate the food in this image and log it.';
  content.push({ type: 'text', text: userText });
  const requestType = image ? 'image' : 'text';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
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
      return res.status(200).json({
        ok: false,
        error: 'Could not understand that. Try rephrasing.',
        raw: textOut,
        usage: {
          provider: 'anthropic',
          model: MODEL,
          requestType,
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
        },
      });
    }
    return res.status(200).json({
      ok: true,
      result: parsed,
      usage: {
        provider: 'anthropic',
        model: MODEL,
        requestType,
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

// Give the function headroom for image analysis (Vercel default can be as low as 10s).
module.exports.config = { maxDuration: 60 };
