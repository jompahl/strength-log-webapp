// api/_supabase.js — server-side Supabase helpers for the serverless functions.
//
// Auth model: the browser sends its Supabase access token as `Authorization: Bearer <jwt>`.
// We validate it and build a per-request client that acts AS that user (RLS + auth.uid()),
// so the Vault RPCs (get/set/delete_integration) resolve to the caller's own secret.
// No service-role key needed — only the public publishable key.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nofrspjygkfumxrgyjwa.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_4na9OUXbjR0yq4oKl4FrDw_68B9dznN';

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
async function getIntegration(client, provider) {
  const { data, error } = await client.rpc('get_integration', { p_provider: provider });
  if (error) throw new Error(error.message);
  return data || null;
}

async function setIntegration(client, provider, secret, meta) {
  const { error } = await client.rpc('set_integration', { p_provider: provider, p_secret: secret, p_meta: meta || {} });
  if (error) throw new Error(error.message);
}

async function deleteIntegration(client, provider) {
  const { error } = await client.rpc('delete_integration', { p_provider: provider });
  if (error) throw new Error(error.message);
}

module.exports = { verifyUser, getIntegration, setIntegration, deleteIntegration };
