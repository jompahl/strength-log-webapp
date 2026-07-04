const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SA_KEY = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
const SESSION_SECRET = process.env.SESSION_SECRET || GOOGLE_SA_KEY;
const SESSION_COOKIE = 'strengthlog_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const googleAuth = new OAuth2Client(GOOGLE_CLIENT_ID);

function sessionConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && SESSION_SECRET);
}

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID || !idToken) return null;
  try {
    const ticket = await googleAuth.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    return { sub: payload.sub, email: payload.email, name: payload.name || payload.email };
  } catch (e) { return null; }
}

function signingKey() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('strength-log/session/v1').digest();
}

function signSession(user, now = Date.now()) {
  if (!sessionConfigured()) throw new Error('Session authentication is not configured');
  const payload = {
    sub: String(user.sub || ''),
    email: String(user.email || ''),
    name: String(user.name || user.email || 'Account'),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  if (!payload.sub) throw new Error('Cannot create a session without a user ID');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySession(value, now = Date.now()) {
  if (!sessionConfigured()) return null;
  const [encoded, supplied] = String(value || '').split('.');
  if (!encoded || !supplied) return null;
  const expected = crypto.createHmac('sha256', signingKey()).update(encoded).digest();
  const actual = Buffer.from(supplied, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.sub || !payload.exp || payload.exp * 1000 <= now) return null;
    return { sub: payload.sub, email: payload.email || '', name: payload.name || payload.email || 'Account' };
  } catch (e) { return null; }
}

function cookieValue(req, name) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sessionUser(req) {
  return verifySession(cookieValue(req, SESSION_COOKIE));
}

async function verifyRequestUser(req, idToken) {
  if (idToken && idToken !== 'session') {
    const googleUser = await verifyGoogleIdToken(idToken);
    if (googleUser) return googleUser;
  }
  return sessionUser(req);
}

function isSecureRequest(req) {
  return String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(user, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession(user))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function clearSessionCookie(req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

module.exports = {
  SESSION_TTL_SECONDS, clearSessionCookie, sessionConfigured, sessionCookie, sessionUser,
  signSession, verifyGoogleIdToken, verifyRequestUser, verifySession,
};
