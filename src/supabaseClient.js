// Shared Supabase browser client.
// The publishable key is safe to ship to the browser — RLS enforces per-user access.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://nofrspjygkfumxrgyjwa.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4na9OUXbjR0yq4oKl4FrDw_68B9dznN';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,       // keep the user signed in across reloads
    autoRefreshToken: true,     // refresh the JWT before it expires
    detectSessionInUrl: false,  // one-tap ID-token flow, no redirect callback to parse
  },
});
