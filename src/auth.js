// Supabase-backed Google one-tap sign-in.
//
// One-tap + Supabase uses a nonce split in two: the SHA-256 HASH goes to Google
// (embedded in the returned ID token's nonce claim), and the RAW value goes to
// Supabase, which re-hashes it and compares. This proves the token was minted
// for this session. (Supabase "Skip nonce checks" stays OFF.)
import { supabase } from './supabaseClient.js';

// Returns { raw, hashed }: pass `hashed` to google.accounts.id.initialize({nonce}),
// and `raw` to signInWithGoogleCredential().
export async function makeNonce() {
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { raw, hashed };
}

// Exchange a Google one-tap credential (JWT) for a Supabase session.
export async function signInWithGoogleCredential(credential, rawNonce) {
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'google',
    token: credential,
    nonce: rawNonce,
  });
  if (error) throw error;
  return mapUser(data.session);
}

// Normalize a Supabase session into the app's { sub, email, name } shape.
export function mapUser(session) {
  const u = session?.user;
  if (!u) return null;
  const meta = u.user_metadata || {};
  return {
    sub: u.id,                                   // Supabase user id (used as user_id in every table)
    email: u.email || meta.email || '',
    name: meta.full_name || meta.name || u.email || 'Account',
  };
}

// Current session's user, or null. Reads the persisted session (no network).
export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return mapUser(data.session);
}

// React to sign-in / sign-out / token-refresh. Returns an unsubscribe handle.
export function onAuthChange(handler) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => handler(mapUser(session)));
  return () => data.subscription.unsubscribe();
}

export async function signOut() {
  await supabase.auth.signOut();
}

// The current Supabase access token (JWT), for authorizing calls to our serverless functions.
export async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || '';
}
