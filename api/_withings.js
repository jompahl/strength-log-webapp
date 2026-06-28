const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
const SHEET_ID = process.env.SHEET_ID;
const WITHINGS_CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
const WITHINGS_CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const WITHINGS_REDIRECT_URI = process.env.WITHINGS_REDIRECT_URI;
const WITHINGS_WEBHOOK_URI = process.env.WITHINGS_WEBHOOK_URI;
const WITHINGS_WEBHOOK_SECRET = process.env.WITHINGS_WEBHOOK_SECRET;
const TOKEN_SECRET = process.env.WITHINGS_TOKEN_ENCRYPTION_KEY;
const AUTH_TAB = 'WithingsAuth';
const DATA_TAB = 'UserData';
const JSON_CHUNK_SIZE = 45000;
const googleAuth = new OAuth2Client(GOOGLE_CLIENT_ID);

function isConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && SA_EMAIL && SA_KEY && SHEET_ID && WITHINGS_CLIENT_ID &&
    WITHINGS_CLIENT_SECRET && WITHINGS_REDIRECT_URI && TOKEN_SECRET);
}

function webhookUrl() {
  if (!WITHINGS_WEBHOOK_URI || !WITHINGS_WEBHOOK_SECRET) return '';
  const url = new URL(WITHINGS_WEBHOOK_URI);
  url.searchParams.set('token', WITHINGS_WEBHOOK_SECRET);
  return url.toString();
}

async function verifyGoogleUser(idToken) {
  try {
    const ticket = await googleAuth.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    return { sub: payload.sub, email: payload.email };
  } catch (e) { return null; }
}

function sheetsClient() {
  const jwt = new google.auth.JWT(SA_EMAIL, null, SA_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth: jwt });
}

async function ensureAuthTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(sheet => sheet.properties.title === AUTH_TAB);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: AUTH_TAB, hidden: true } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${AUTH_TAB}!A1:D1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['user_id', 'withings_user_id', 'encrypted_token', 'updated_at']] },
  });
}

async function authRows(sheets) {
  await ensureAuthTab(sheets);
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A2:D` });
  return result.data.values || [];
}

function encryptionKey() { return crypto.createHash('sha256').update(TOKEN_SECRET).digest(); }

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(value) {
  const [version, iv, tag, encrypted] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted Withings token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

async function loadToken(sub) {
  const rows = await authRows(sheetsClient());
  const row = rows.find(values => values[0] === sub && values[2]);
  if (!row) return null;
  try { return decrypt(row[2]); } catch (e) { return null; }
}

async function loadTokenByWithingsUserId(userId) {
  const rows = await authRows(sheetsClient());
  const row = rows.find(values => String(values[1]) === String(userId) && values[2]);
  if (!row) return null;
  try { return { sub: row[0], token: decrypt(row[2]) }; } catch (e) { return null; }
}

async function saveToken(sub, token) {
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const index = rows.findIndex(values => values[0] === sub);
  const values = [[sub, String(token.userId || ''), encrypt(token), new Date().toISOString()]];
  if (index === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A:D`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values },
    });
  } else {
    const rowNumber = index + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A${rowNumber}:D${rowNumber}`, valueInputOption: 'RAW', requestBody: { values },
    });
  }
}

async function deleteToken(sub) {
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const index = rows.findIndex(values => values[0] === sub);
  if (index === -1) return;
  const rowNumber = index + 2;
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A${rowNumber}:D${rowNumber}` });
}

function signState(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(value) {
  const [encoded, supplied] = String(value || '').split('.');
  if (!encoded || !supplied) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest();
  const actual = Buffer.from(supplied, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch (e) { return null; }
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const part of cookies) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

async function withingsRequest(url, params, accessToken = '') {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: new URLSearchParams(params),
  });
  const data = await response.json();
  if (!response.ok || Number(data.status) !== 0) {
    throw new Error(data.error || data.body?.error || `Withings API error ${data.status ?? response.status}`);
  }
  return data.body || {};
}

async function tokenRequest(params) {
  return withingsRequest('https://wbsapi.withings.net/v2/oauth2', {
    action: 'requesttoken', client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET, ...params,
  });
}

function normalizeToken(data, previous = {}) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 10800) * 1000,
    scope: data.scope || previous.scope || '',
    userId: data.userid || previous.userId,
    webhookSubscribed: Boolean(previous.webhookSubscribed),
    connectedAt: previous.connectedAt || new Date().toISOString(),
  };
}

async function usableToken(sub) {
  let token = await loadToken(sub);
  if (!token) return null;
  if (token.expiresAt > Date.now() + 60000) return token;
  if (!token.refreshToken) throw new Error('Withings authorization expired. Reconnect Withings.');
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
  token = normalizeToken(refreshed, token);
  await saveToken(sub, token);
  return token;
}

function dateInZone(timestamp, timeZone) {
  const date = new Date(Number(timestamp) * 1000);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch (e) { return date.toISOString().slice(0, 10); }
}

async function fetchWeights(accessToken, { startDate, endDate, lastUpdate } = {}) {
  const all = [];
  let offset = '';
  for (let page = 0; page < 20; page++) {
    const params = { action: 'getmeas', meastype: '1', category: '1' };
    if (lastUpdate) params.lastupdate = String(lastUpdate);
    else {
      if (startDate) params.startdate = String(startDate);
      if (endDate) params.enddate = String(endDate);
    }
    if (offset !== '') params.offset = String(offset);
    const body = await withingsRequest('https://wbsapi.withings.net/measure', params, accessToken);
    const timezone = body.timezone || 'UTC';
    for (const group of body.measuregrps || []) {
      const measure = (group.measures || []).find(item => Number(item.type) === 1);
      if (!measure) continue;
      const kg = Number(measure.value) * (10 ** Number(measure.unit || 0));
      if (!Number.isFinite(kg) || kg <= 0 || kg > 600) continue;
      all.push({
        date: dateInZone(group.date, timezone),
        kg: Math.round(kg * 1000) / 1000,
        source: 'withings',
        measuredAt: new Date(Number(group.date) * 1000).toISOString(),
        externalId: `withings:${group.grpid}`,
      });
    }
    if (!body.more) break;
    offset = body.offset;
  }
  return all;
}

async function notificationRequest(action, accessToken) {
  const callbackurl = webhookUrl();
  if (!callbackurl) return false;
  await withingsRequest('https://wbsapi.withings.net/notify', {
    action, callbackurl, appli: '1', ...(action === 'subscribe' ? { comment: 'Strength Log automatic weight sync' } : {}),
  }, accessToken);
  return true;
}

function mergeWeightRows(existing, incoming) {
  const byDate = new Map((existing || []).map(row => [row.date, row]));
  const sorted = [...incoming].sort((a, b) => String(a.measuredAt).localeCompare(String(b.measuredAt)));
  sorted.forEach(row => byDate.set(row.date, row));
  return [...byDate.values()].filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number(row.kg) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function updateProfileWeight(data) {
  const latest = (data.weights || [])[data.weights.length - 1];
  if (!latest || !data.profile) return;
  data.profile.weight_kg = latest.kg;
  if (data.profile.height_cm && data.profile.age) {
    const base = (10 * latest.kg) + (6.25 * data.profile.height_cm) - (5 * data.profile.age);
    data.profile.bmr = Math.round(base + (data.profile.sex === 'female' ? -161 : 5));
    data.profile.maintenance = Math.round(data.profile.bmr * Number(data.profile.activityMult || 1.2));
  }
}

async function mergeWeightsIntoCloud(sub, incoming) {
  if (!incoming.length) return { merged: 0 };
  const sheets = sheetsClient();
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${DATA_TAB}!A2:Z` });
  const rows = result.data.values || [];
  const index = rows.findIndex(row => row[0] === sub);
  if (index === -1) return { merged: 0 };
  const row = rows[index];
  let data;
  try { data = JSON.parse(row.slice(3).join('') || '{}'); } catch (e) { data = {}; }
  if (data.withingsBaseWeight == null && data.profile?.weight_kg) data.withingsBaseWeight = data.profile.weight_kg;
  data.weights = mergeWeightRows(data.weights || [], incoming);
  data.withingsLastSync = new Date().toISOString();
  updateProfileWeight(data);
  const json = JSON.stringify(data);
  const chunks = [];
  for (let i = 0; i < json.length; i += JSON_CHUNK_SIZE) chunks.push(json.slice(i, i + JSON_CHUNK_SIZE));
  const sheetRow = index + 2;
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${DATA_TAB}!A${sheetRow}:Z${sheetRow}` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${DATA_TAB}!A${sheetRow}`, valueInputOption: 'RAW',
    requestBody: { values: [[row[0], row[1] || '', row[2] || '', ...chunks]] },
  });
  return { merged: incoming.length };
}

function verifyWebhookSecret(value) {
  const supplied = Buffer.from(String(value || ''));
  const expected = Buffer.from(String(WITHINGS_WEBHOOK_SECRET || ''));
  return supplied.length === expected.length && supplied.length > 0 && crypto.timingSafeEqual(supplied, expected);
}

module.exports = {
  WITHINGS_CLIENT_ID, WITHINGS_REDIRECT_URI, cookieValue, deleteToken, fetchWeights, isConfigured,
  loadToken, loadTokenByWithingsUserId, mergeWeightsIntoCloud, normalizeToken, notificationRequest,
  saveToken, signState, tokenRequest, usableToken, verifyGoogleUser, verifyState, verifyWebhookSecret, webhookUrl,
};
