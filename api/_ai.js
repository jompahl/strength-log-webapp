// api/_ai.js — one place that decides WHICH model to call for a signed-in user.
//
// Bring-your-own-key: a user can store their own OpenRouter API key. When present we
// call OpenRouter (OpenAI-compatible) with their chosen model and THEIR credit.
// When absent we fall back to the app's own Anthropic key (ANTHROPIC_API_KEY).
//
// The user's key is encrypted at rest (AES-256-GCM) in a hidden Sheet tab, mirroring
// the Oura/Withings token storage. It is never returned to the client in plaintext.
//
// Env vars:
//   GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, SHEET_ID   central Sheet (already used by sync)
//   AI_KEY_ENCRYPTION_KEY                       secret used to encrypt stored keys
//   ANTHROPIC_API_KEY                           the app's fallback key
//   OPENROUTER_APP_URL / OPENROUTER_APP_NAME    optional attribution headers

const crypto = require('node:crypto');
const { google } = require('googleapis');

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
const SHEET_ID = process.env.SHEET_ID;
const KEY_SECRET = process.env.AI_KEY_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const AUTH_TAB = 'AiKeys';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

function keyStorageConfigured() {
  return Boolean(SA_EMAIL && SA_KEY && SHEET_ID && KEY_SECRET);
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
    requestBody: { values: [['user_id', 'encrypted_key', 'model', 'updated_at']] },
  });
}

async function authRows(sheets) {
  await ensureAuthTab(sheets);
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A2:D` });
  return result.data.values || [];
}

function encryptionKey() { return crypto.createHash('sha256').update(KEY_SECRET).digest(); }

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(value) {
  const [version, iv, tag, encrypted] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted key');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
  return plain.toString('utf8');
}

// { key, model } for the user, or null when they have not set one up.
async function loadUserKey(sub) {
  if (!keyStorageConfigured() || !sub) return null;
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const row = rows.find(values => values[0] === sub && values[1]);
  if (!row) return null;
  try { return { key: decrypt(row[1]), model: row[2] || DEFAULT_OPENROUTER_MODEL }; }
  catch (e) { return null; }
}

async function saveUserKey(sub, key, model) {
  if (!keyStorageConfigured()) throw new Error('AI key storage is not configured on the server.');
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const index = rows.findIndex(values => values[0] === sub);
  const values = [[sub, encrypt(key), model || DEFAULT_OPENROUTER_MODEL, new Date().toISOString()]];
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

async function deleteUserKey(sub) {
  if (!keyStorageConfigured()) return;
  const sheets = sheetsClient();
  const rows = await authRows(sheets);
  const index = rows.findIndex(values => values[0] === sub);
  if (index === -1) return;
  const rowNumber = index + 2;
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${AUTH_TAB}!A${rowNumber}:D${rowNumber}` });
}

// { hasKey, model } — safe to send to the client (never includes the key itself).
async function keyStatus(sub) {
  const stored = await loadUserKey(sub);
  return { hasKey: Boolean(stored), model: stored ? stored.model : DEFAULT_OPENROUTER_MODEL, configured: keyStorageConfigured() };
}

// Convert Anthropic-style content blocks into OpenAI/OpenRouter chat content.
function toOpenAiContent(content) {
  return content.map(block => {
    if (block.type === 'image') {
      const src = block.source || {};
      return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/jpeg'};base64,${src.data}` } };
    }
    return { type: 'text', text: block.text || '' };
  });
}

async function callOpenRouter({ apiKey, model, system, content, maxTokens }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (process.env.OPENROUTER_APP_URL) headers['HTTP-Referer'] = process.env.OPENROUTER_APP_URL;
  headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'Strength Log';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: toOpenAiContent(content) },
  ];
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });
  const data = await response.json();
  if (data.error) { const err = new Error(data.error.message || 'OpenRouter API error'); err.provider = 'openrouter'; throw err; }
  const choice = (data.choices && data.choices[0]) || {};
  const text = String(choice.message?.content || '').trim();
  return {
    text,
    provider: 'openrouter',
    model,
    stopReason: choice.finish_reason || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function callAnthropic({ system, content, maxTokens }) {
  if (!ANTHROPIC_KEY) { const err = new Error('Server missing ANTHROPIC_API_KEY.'); err.provider = 'anthropic'; throw err; }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const data = await response.json();
  if (data.error) { const err = new Error(data.error.message || 'Claude API error'); err.provider = 'anthropic'; throw err; }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return {
    text,
    provider: 'anthropic',
    model: ANTHROPIC_MODEL,
    stopReason: data.stop_reason || '',
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

// Main entry point. Routes to the user's OpenRouter key when set, else the app's key.
// `content` is an array of Anthropic-style blocks: { type:'text', text } / { type:'image', source }.
// Returns { text, provider, model, stopReason, inputTokens, outputTokens }.
async function generate({ sub, system, content, maxTokens }) {
  let stored = null;
  try { stored = await loadUserKey(sub); } catch (e) { stored = null; }
  if (stored && stored.key) {
    return callOpenRouter({ apiKey: stored.key, model: stored.model, system, content, maxTokens });
  }
  return callAnthropic({ system, content, maxTokens });
}

module.exports = {
  DEFAULT_OPENROUTER_MODEL,
  keyStorageConfigured,
  loadUserKey,
  saveUserKey,
  deleteUserKey,
  keyStatus,
  generate,
};
