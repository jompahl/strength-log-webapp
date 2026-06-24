// api/sync.js — Vercel serverless function
// Holds the service-account credential (server-side only) and the central Sheet.
// Verifies each request's Google ID token so a user can only touch their own rows.

const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

// ---- Environment variables (set these in Vercel project settings) ----
//   GOOGLE_CLIENT_ID         the OAuth client ID (also used in the frontend)
//   GOOGLE_SA_EMAIL          service account email
//   GOOGLE_SA_KEY            service account private key (the long PEM, with \n)
//   SHEET_ID                 the central spreadsheet ID (from its URL)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SA_EMAIL  = process.env.GOOGLE_SA_EMAIL;
const SA_KEY    = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
const SHEET_ID  = process.env.SHEET_ID;
const DATA_TAB  = 'UserData';     // hidden-ish tab holding JSON blobs per user

const authClient = new OAuth2Client(CLIENT_ID);

// Verify the Google ID token from the browser; returns {sub, email, name} or null.
async function verifyUser(idToken) {
  try {
    const ticket = await authClient.verifyIdToken({ idToken, audience: CLIENT_ID });
    const p = ticket.getPayload();
    return { sub: p.sub, email: p.email, name: p.name || p.email };
  } catch (e) {
    return null;
  }
}

function sheetsClient() {
  const jwt = new google.auth.JWT(SA_EMAIL, null, SA_KEY, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  return google.sheets({ version: 'v4', auth: jwt });
}

// Ensure the data tab exists and has a header row.
async function ensureTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === DATA_TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: DATA_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${DATA_TAB}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['user_id', 'email', 'name', 'data_json']] },
    });
  }
}

async function readAll(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${DATA_TAB}!A2:D`,
  });
  return res.data.values || [];
}

async function loadUser(sheets, sub) {
  const rows = await readAll(sheets);
  for (const r of rows) {
    if (r[0] === sub) {
      try { return JSON.parse(r[3] || '{}'); } catch (e) { return {}; }
    }
  }
  return null;
}

async function saveUser(sheets, user, data) {
  const rows = await readAll(sheets);
  let rowIndex = -1; // 0-based within data rows
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === user.sub) { rowIndex = i; break; }
  }
  const values = [[user.sub, user.email, user.name, JSON.stringify(data)]];
  if (rowIndex === -1) {
    // append
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${DATA_TAB}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  } else {
    const sheetRow = rowIndex + 2; // +1 header, +1 to 1-based
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${DATA_TAB}!A${sheetRow}:D${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }
}

// Also mirror to readable per-user tabs on save (best-effort, non-blocking).
async function mirror(sheets, user, data) {
  const safe = (user.name || user.email || user.sub).replace(/[^\w \-]/g, '').slice(0, 60) || user.sub.slice(0, 12);
  const tab = `${safe}`.trim() || 'user';
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === tab);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
      });
    }
    const rows = [];
    rows.push(['Type', 'Date', 'Detail', 'A', 'B', 'C']);
    (data.weights || []).forEach(w => rows.push(['Weight', w.date, '', w.kg, '', '']));
    (data.food || []).forEach(f => rows.push(['Food', f.date, f.name, f.kcal, f.p || 0, '']));
    (data.entries || []).forEach(en => {
      if (en.kind === 'cardio') rows.push(['Cardio', en.date, en.activity || '', en.distance_km || '', en.duration_min || '', en.calories || '']);
      else if (en.kind === 'strength') en.exercises.forEach(ex => ex.sets.forEach((s, i) =>
        rows.push(['Strength', en.date, `${ex.name} set ${i + 1}`, s.reps, s.weight, en.type])));
    });
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A:F` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  } catch (e) { /* mirror is best-effort */ }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  if (!CLIENT_ID || !SA_EMAIL || !SA_KEY || !SHEET_ID) {
    return res.status(500).json({ ok: false, error: 'Server not configured (missing env vars).' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { idToken, action, data } = body || {};

  const user = await verifyUser(idToken);
  if (!user) return res.status(401).json({ ok: false, error: 'Sign-in expired or invalid. Please sign in again.' });

  try {
    const sheets = sheetsClient();
    await ensureTab(sheets);

    if (action === 'load') {
      const d = await loadUser(sheets, user.sub);
      return res.status(200).json({ ok: true, data: d, user: { email: user.email, name: user.name } });
    }
    if (action === 'save') {
      await saveUser(sheets, user, data || {});
      mirror(sheets, user, data || {}); // fire-and-forget
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
