// Supabase data layer — replaces the /api/sync blob push/pull.
//
// The app keeps its in-memory STORE + localStorage cache and all rendering code.
// This module only bridges STORE <-> Supabase tables (RLS scopes every query to the
// signed-in user, so no user_id is passed from the client).
//
// MIGRATION STATE: profile + weights are live against Supabase. The remaining
// collections (workouts/entries, food, creatine, oura_daily, ai_usage, strength cycle)
// are converted in later slices; until then loadAll() returns them empty and saveAll()
// leaves them alone.
import { supabase } from './supabaseClient.js';

// Pull the signed-in user's data into a STORE-shaped payload (consumed by applyPayload).
export async function loadAll() {
  const [profileRes, weightsRes] = await Promise.all([
    supabase.from('profiles').select('data, coach_id, seed_imported').maybeSingle(),
    supabase.from('weights').select('date, kg, source').order('date', { ascending: true }),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (weightsRes.error) throw weightsRes.error;

  const profileRow = profileRes.data;
  return {
    profile: profileRow?.data || {},
    coachId: profileRow?.coach_id || null,
    seedImported: profileRow?.seed_imported ?? false,
    weights: (weightsRes.data || []).map(w => ({ date: w.date, kg: Number(w.kg), source: w.source || 'manual' })),
    // not yet migrated — kept empty so rendering works without the old blob:
    entries: [], food: [], foodFavorites: [], creatine: [], aiUsage: [],
    ouraDaily: [], strengthCycle: null, withingsLastSync: null, withingsBaseWeight: null,
  };
}

// Persist the parts of STORE that are migrated. Called by the debounced pushNow().
export async function saveAll(store) {
  const { data } = await supabase.auth.getSession();   // local, no network
  const userId = data.session?.user?.id;
  if (!userId) return;
  await Promise.all([
    saveProfile(store, userId),
    saveWeights(store.weights || [], userId),
  ]);
}

async function saveProfile(store, userId) {
  const { error } = await supabase.from('profiles').upsert({
    user_id: userId,
    data: store.profile || {},
    coach_id: store.coachId || null,
    seed_imported: !!store.seedImported,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// Weigh-ins are keyed (user_id, date, source); upsert current rows. We only manage
// manual weigh-ins from here — Withings/Oura rows are written by their sync paths.
async function saveWeights(weights, userId) {
  const rows = weights
    .filter(w => w && w.date && w.kg != null)
    .map(w => ({ user_id: userId, date: w.date, kg: w.kg, source: w.source || 'manual' }));
  if (!rows.length) return;
  const { error } = await supabase.from('weights').upsert(rows, { onConflict: 'user_id,date,source' });
  if (error) throw error;
}
