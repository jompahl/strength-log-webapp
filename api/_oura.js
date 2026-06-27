const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
const SHEET_ID = process.env.SHEET_ID;
const OURA_CLIENT_ID = process.env.OURA_CLIENT_ID;
const OURA_CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
const OURA_REDIRECT_URI = process.env.OURA_REDIRECT_URI;
const TOKEN_SECRET = process.env.OURA_TOKEN_ENCRYPTION_KEY;
const AUTH_TAB = 'OuraAuth';
const googleAuth = new OAuth2Client(GOOGLE_CLIENT_ID);

function isConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && SA_EMAIL && SA_KEY && SHEET_ID && OURA_CLIENT_ID && OURA_CLIENT_SECRET && OURA_REDIRECT_URI && TOKEN_SECRET);
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
    range: `${AUTH_TAB}!A1:C1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['user_id', 'encrypted_token', 'updated_at']] },
  });
}

async function authRows(sheets) {
  await ensureAuthTab(sheets);
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A2:C` });
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
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

async function loadToken(sub) {
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const row = rows.find(values => values[0] === sub && values[1]);
  if (!row) return null;
  try { return decrypt(row[1]); } catch (e) { return null; }
}

async function saveToken(sub, token) {
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const index = rows.findIndex(values => values[0] === sub);
  const values = [[sub, encrypt(token), new Date().toISOString()]];
  if (index === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A:C`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values },
    });
  } else {
    const rowNumber = index + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A${rowNumber}:C${rowNumber}`, valueInputOption: 'RAW', requestBody: { values },
    });
  }
}

async function deleteToken(sub) {
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const index = rows.findIndex(values => values[0] === sub);
  if (index === -1) return;
  const rowNumber = index + 2;
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A${rowNumber}:C${rowNumber}` });
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

async function tokenRequest(params) {
  const response = await fetch('https://api.ouraring.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: OURA_CLIENT_ID, client_secret: OURA_CLIENT_SECRET }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Oura token exchange failed');
  return data;
}

function normalizeToken(data, previous = {}) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 2592000) * 1000,
    scope: data.scope || previous.scope || '',
    connectedAt: previous.connectedAt || new Date().toISOString(),
  };
}

async function usableToken(sub) {
  let token = await loadToken(sub);
  if (!token) return null;
  if (token.expiresAt > Date.now() + 60000) return token;
  if (!token.refreshToken) throw new Error('Oura authorization expired. Reconnect Oura.');
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
  token = normalizeToken(refreshed, token);
  await saveToken(sub, token);
  return token;
}

async function fetchDailyActivity(accessToken, startDate, endDate) {
  const all = [];
  let nextToken = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.ouraring.com/v2/usercollection/daily_activity');
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
    if (nextToken) url.searchParams.set('next_token', nextToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || 'Could not load Oura activity data');
    all.push(...(data.data || []));
    nextToken = data.next_token || '';
    if (!nextToken) break;
  }
  return all;
}

module.exports = {
  OURA_CLIENT_ID, OURA_REDIRECT_URI, cookieValue, deleteToken, fetchDailyActivity, isConfigured,
  loadToken, normalizeToken, saveToken, signState, tokenRequest, usableToken, verifyGoogleUser, verifyState,
};
