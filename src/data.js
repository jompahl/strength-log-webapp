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
  const [profileRes, weightsRes, workoutsRes, cardioRes, creatineRes, foodsRes, favoritesRes, cycleRes, usageRes] = await Promise.all([
    supabase.from('profiles').select('data, coach_id, seed_imported').maybeSingle(),
    supabase.from('weights').select('date, kg, source').order('date', { ascending: true }),
    supabase.from('workouts')
      .select('id, date, type, name, import_id, workout_exercises(id, name, muscle, position, workout_sets(reps, weight, duration_sec, warmup, position))')
      .order('date', { ascending: true }),
    supabase.from('cardio_sessions')
      .select('id, date, activity, distance_km, duration_min, pace_min_km, calories, note, import_id')
      .order('date', { ascending: true }),
    supabase.from('creatine').select('date, grams').order('date', { ascending: true }),
    supabase.from('foods').select('client_id, date, name, kcal, protein_g, carbs_g, fat_g').order('date', { ascending: true }),
    supabase.from('food_favorites').select('client_id, name, kcal, protein_g, carbs_g, fat_g'),
    supabase.from('strength_cycles').select('plan').eq('active', true).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ai_usage').select('id, ts, provider, model, request_type, input_tokens, output_tokens').order('ts', { ascending: true }),
  ]);
  for (const r of [profileRes, weightsRes, workoutsRes, cardioRes, creatineRes, foodsRes, favoritesRes, cycleRes, usageRes]) if (r.error) throw r.error;

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
    food: (foodsRes.data || []).map(f => ({
      _id: f.client_id, date: f.date, name: f.name,
      kcal: f.kcal, p: f.protein_g, c: f.carbs_g, fat: f.fat_g,
    })),
    foodFavorites: (favoritesRes.data || []).map(f => ({
      _id: f.client_id, name: f.name,
      kcal: f.kcal, p: f.protein_g, c: f.carbs_g, fat: f.fat_g,
    })),
    strengthCycle: cycleRes.data?.plan || null,
    aiUsage: (usageRes.data || []).map(u => {
      const inputTokens = u.input_tokens || 0, outputTokens = u.output_tokens || 0;
      return {
        id: 'ai' + u.id, createdAt: u.ts, provider: u.provider || 'anthropic', model: u.model || '',
        requestType: u.request_type || 'text', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      };
    }),
    // not yet migrated — kept empty so rendering works without the old blob:
    ouraDaily: [], withingsLastSync: null, withingsBaseWeight: null,
  };
}

// ---- Strength cycle (single active JSONB plan per user) ----
export async function saveStrengthCycle(plan) {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not signed in.');
  const del = await supabase.from('strength_cycles').delete().eq('user_id', userId);
  if (del.error) throw del.error;
  if (plan) {
    const { error } = await supabase.from('strength_cycles').insert({ user_id: userId, plan, active: true });
    if (error) throw error;
  }
}

// ---- AI usage events (append-only) ----
export async function recordAiUsageRow(usage) {
  const userId = await currentUserId();
  if (!userId) return;
  const { error } = await supabase.from('ai_usage').insert({
    user_id: userId, provider: usage.provider || null, model: usage.model || null,
    request_type: usage.requestType || null,
    input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0,
  });
  if (error) throw error;
}

// ---- Food log + favorites (keyed by the app's client _id) ----
export async function insertFood(food) {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not signed in.');
  const { error } = await supabase.from('foods').insert({
    user_id: userId, client_id: food._id, date: food.date, name: food.name,
    kcal: food.kcal ?? null, protein_g: food.p ?? null, carbs_g: food.c ?? null, fat_g: food.fat ?? null,
  });
  if (error) throw error;
}
export async function deleteFood(clientId) {
  const userId = await currentUserId();
  if (!userId) return;
  const { error } = await supabase.from('foods').delete().eq('user_id', userId).eq('client_id', clientId);
  if (error) throw error;
}
export async function insertFavorite(fav) {
  const userId = await currentUserId();
  if (!userId) throw new Error('Not signed in.');
  const { error } = await supabase.from('food_favorites').insert({
    user_id: userId, client_id: fav._id, name: fav.name,
    kcal: fav.kcal ?? null, protein_g: fav.p ?? null, carbs_g: fav.c ?? null, fat_g: fav.fat ?? null,
  });
  if (error) throw error;
}
export async function deleteFavorite(clientId) {
  const userId = await currentUserId();
  if (!userId) return;
  const { error } = await supabase.from('food_favorites').delete().eq('user_id', userId).eq('client_id', clientId);
  if (error) throw error;
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
