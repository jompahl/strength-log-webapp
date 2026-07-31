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
  const [profileRes, weightsRes, workoutsRes, cardioRes, creatineRes] = await Promise.all([
    supabase.from('profiles').select('data, coach_id, seed_imported').maybeSingle(),
    supabase.from('weights').select('date, kg, source').order('date', { ascending: true }),
    supabase.from('workouts')
      .select('id, date, type, name, import_id, workout_exercises(id, name, muscle, position, workout_sets(reps, weight, duration_sec, warmup, position))')
      .order('date', { ascending: true }),
    supabase.from('cardio_sessions')
      .select('id, date, activity, distance_km, duration_min, pace_min_km, calories, note, import_id')
      .order('date', { ascending: true }),
    supabase.from('creatine').select('date, grams').order('date', { ascending: true }),
  ]);
  for (const r of [profileRes, weightsRes, workoutsRes, cardioRes, creatineRes]) if (r.error) throw r.error;

  const profileRow = profileRes.data;
  const strengthEntries = (workoutsRes.data || []).map(fromWorkoutRow);
  const cardioEntries = (cardioRes.data || []).map(fromCardioRow);
  const entries = [...strengthEntries, ...cardioEntries].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    profile: profileRow?.data || {},
    coachId: profileRow?.coach_id || null,
    seedImported: profileRow?.seed_imported ?? false,
    weights: (weightsRes.data || []).map(w => ({ date: w.date, kg: Number(w.kg), source: w.source || 'manual' })),
    entries,
    creatine: (creatineRes.data || []).map(c => ({ date: c.date, grams: Number(c.grams) })),
    // not yet migrated — kept empty so rendering works without the old blob:
    food: [], foodFavorites: [], aiUsage: [],
    ouraDaily: [], strengthCycle: null, withingsLastSync: null, withingsBaseWeight: null,
  };
}

// ---- Creatine (one row per day, keyed by date) ----
export async function upsertCreatine(date, grams) {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not signed in.');
  const { error } = await supabase.from('creatine')
    .upsert({ user_id: userId, date, grams }, { onConflict: 'user_id,date' });
  if (error) throw error;
}
export async function deleteCreatine(date) {
  const userId = await currentUserId();
  if (!userId) return;
  const { error } = await supabase.from('creatine').delete().eq('user_id', userId).eq('date', date);
  if (error) throw error;
}

function fromWorkoutRow(w) {
  const exercises = (w.workout_exercises || [])
    .sort((a, b) => a.position - b.position)
    .map(ex => ({
      name: ex.name,
      muscle: ex.muscle || undefined,
      sets: (ex.workout_sets || [])
        .sort((a, b) => a.position - b.position)
        .map(s => {
          const set = { reps: s.reps, weight: s.weight == null ? null : Number(s.weight) };
          if (s.duration_sec != null) set.duration_sec = s.duration_sec;
          if (s.warmup) set.warmup = true;
          return set;
        }),
    }));
  const entry = { kind: 'strength', id: w.id, date: w.date, type: w.type, exercises };
  if (w.name) entry.name = w.name;
  if (w.import_id) entry.importId = w.import_id;
  return entry;
}

function fromCardioRow(c) {
  const entry = {
    kind: 'cardio', id: c.id, date: c.date, activity: c.activity,
    distance_km: c.distance_km == null ? null : Number(c.distance_km),
    duration_min: c.duration_min == null ? null : Number(c.duration_min),
    pace_min_km: c.pace_min_km == null ? null : Number(c.pace_min_km),
    calories: c.calories, note: c.note || undefined,
  };
  if (c.import_id) entry.importId = c.import_id;
  return entry;
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

// ---- Entries (append-only): strength workouts + cardio ----
// Insert one entry (strength or cardio). Returns the new DB id.
export async function insertEntry(entry) {
  return entry.kind === 'cardio' ? insertCardio(entry) : insertWorkout(entry);
}

// Insert several entries in order (used by AI/CSV/JSON import). Returns count inserted.
export async function insertEntries(entries) {
  let n = 0;
  for (const e of entries) { await insertEntry(e); n++; }
  return n;
}

async function insertWorkout(entry) {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not signed in.');
  const { data: workout, error } = await supabase.from('workouts')
    .insert({ user_id: userId, date: entry.date, type: entry.type || 'Other', name: entry.name || null, import_id: entry.importId || null })
    .select('id').single();
  if (error) throw error;

  const exercises = entry.exercises || [];
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    const { data: exRow, error: exErr } = await supabase.from('workout_exercises')
      .insert({ workout_id: workout.id, user_id: userId, name: ex.name, muscle: ex.muscle || null, position: i })
      .select('id').single();
    if (exErr) throw exErr;
    const sets = (ex.sets || []).map((s, j) => ({
      exercise_id: exRow.id, user_id: userId,
      reps: s.reps, weight: s.weight ?? null,
      duration_sec: s.duration_sec ?? null, warmup: !!s.warmup, position: j,
    }));
    if (sets.length) {
      const { error: setErr } = await supabase.from('workout_sets').insert(sets);
      if (setErr) throw setErr;
    }
  }
  return workout.id;
}

async function insertCardio(entry) {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not signed in.');
  const { data, error } = await supabase.from('cardio_sessions').insert({
    user_id: userId, date: entry.date, activity: entry.activity,
    distance_km: entry.distance_km ?? null, duration_min: entry.duration_min ?? null,
    pace_min_km: entry.pace_min_km ?? null, calories: entry.calories ?? null,
    note: entry.note || null, import_id: entry.importId || null,
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id || null;
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
