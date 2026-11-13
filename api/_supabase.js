// api/_supabase.js — server-side Supabase helpers for the serverless functions.
//
// Auth model: the browser sends its Supabase access token as `Authorization: Bearer <jwt>`.
// Verify the user with the publishable client before accessing server-only Vault RPCs.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uxfbrtsmdagesdljucro.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_VcN9nc7-rV49IacNWLcQ4Q_n577_KrE';

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match ? match[1] : '';
}

// A Supabase client that carries the user's JWT on every request (RLS applies).
function userClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Validate the request's token. Returns { sub, email, client } or null.
async function verifyUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const client = userClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { sub: data.user.id, email: data.user.email || '', client };
}

// Read the caller's integration secret from Vault. Returns { secret, meta } or null.
async function integrationRpc(user, action, args) {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret?.startsWith('sb_secret_')) throw new Error('Personal AI key storage is not configured on the server.');
  const client = createClient(SUPABASE_URL, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc(action, { ...args, p_user_id: user.sub });
  if (error) throw new Error('Personal AI key storage is unavailable.');
  return data;
}

async function getIntegration(user, provider, { optional = false } = {}) {
  if (optional && !process.env.SUPABASE_SECRET_KEY) return null;
  const data = await integrationRpc(user, 'server_get_integration', { p_provider: provider });
  return data || null;
}

async function setIntegration(user, provider, secret, meta) {
  await integrationRpc(user, 'server_set_integration', { p_provider: provider, p_secret: secret, p_meta: meta || {} });
}

async function deleteIntegration(user, provider) {
  await integrationRpc(user, 'server_delete_integration', { p_provider: provider });
}

module.exports = { verifyUser, getIntegration, setIntegration, deleteIntegration };
