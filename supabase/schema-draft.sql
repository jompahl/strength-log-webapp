-- ============================================================================
-- Strength Log — Supabase schema DRAFT (step 1: shape review, not yet applied)
-- ============================================================================
-- Goal: replace the per-user JSON blob in Google Sheets with normalized tables
-- that serve BOTH the visualization web app and the MCP connector (discrete,
-- concurrent-safe reads/writes).
--
-- Identity: Supabase Auth (Google provider) — auth.users(id) is the user.
-- Every app row carries user_id and is protected by RLS (auth.uid() = user_id).
-- Child tables (exercises/sets) denormalize user_id so RLS stays simple + fast.
--
-- Decisions locked:
--   1. Secrets -> Supabase Vault (key stored off-DB); tables hold only a
--      reference + non-secret metadata. No encrypted blobs in app tables.
--   2. strength_cycles stays JSONB.
--   3. Auth -> Supabase Auth (Google); the hand-rolled HMAC session is dropped.
--
-- STILL TO DO (next steps, not in this file):
--   * One-time blob->rows backfill script (Sheet UserData -> these tables)
--   * Confirm Vault is enabled on the project before applying
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles — one row per user (PK = user_id). Body stats + app settings.
-- ---------------------------------------------------------------------------
-- The app treats the profile as one holistic object (with derived caches like bmr,
-- maintenance, activityMult, onboardingComplete), so it is stored as JSONB rather than a
-- lossy typed mapping. The two top-level app flags stay as columns.
create table public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  data          jsonb not null default '{}'::jsonb,   -- the app's profile object, verbatim
  coach_id      text,
  seed_imported boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Strength: workouts -> exercises -> sets (3 levels, matches the JSON exactly)
-- ---------------------------------------------------------------------------
create table public.workouts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  type        text not null default 'Other' check (type in ('Push','Pull','Legs','Other')),
  name        text,
  created_at  timestamptz not null default now()
);
create index workouts_user_date_idx on public.workouts (user_id, date desc);

create table public.workout_exercises (
  id          bigint generated always as identity primary key,
  workout_id  bigint not null references public.workouts(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade, -- denormalized for RLS
  name        text not null,
  muscle      text,
  position    integer not null default 0
);
create index workout_exercises_workout_idx on public.workout_exercises (workout_id, position);
create index workout_exercises_user_name_idx on public.workout_exercises (user_id, name);

create table public.workout_sets (
  id           bigint generated always as identity primary key,
  exercise_id  bigint not null references public.workout_exercises(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade, -- denormalized for RLS
  reps         integer not null check (reps >= 0),
  weight       numeric,          -- kg; 0 = bodyweight, negative = assisted, null = unknown
  duration_sec integer,          -- for time-based sets
  warmup       boolean not null default false,
  position     integer not null default 0
);
create index workout_sets_exercise_idx on public.workout_sets (exercise_id, position);
create index workout_sets_user_idx on public.workout_sets (user_id); -- covering index for the user_id FK / RLS

-- ---------------------------------------------------------------------------
-- Cardio (was entries with kind='cardio')
-- ---------------------------------------------------------------------------
create table public.cardio_sessions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  date         date not null,
  activity     text not null,
  distance_km  numeric,
  duration_min numeric,
  pace_min_km  numeric,
  calories     integer,
  note         text,
  created_at   timestamptz not null default now()
);
create index cardio_user_date_idx on public.cardio_sessions (user_id, date desc);

-- ---------------------------------------------------------------------------
-- Nutrition: food log + reusable favorites
-- ---------------------------------------------------------------------------
create table public.foods (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  name        text not null,
  kcal        integer,
  protein_g   integer,   -- was "p"
  carbs_g     integer,   -- was "c"
  fat_g       integer,   -- was "fat"
  created_at  timestamptz not null default now()
);
create index foods_user_date_idx on public.foods (user_id, date desc);

create table public.food_favorites (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  kcal        integer,
  protein_g   integer,
  carbs_g     integer,
  fat_g       integer,
  created_at  timestamptz not null default now()
);
create index food_favorites_user_idx on public.food_favorites (user_id);

-- ---------------------------------------------------------------------------
-- Weigh-ins (manual or synced from Withings)
-- ---------------------------------------------------------------------------
create table public.weights (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  kg          numeric not null,
  source      text not null default 'manual' check (source in ('manual','withings','oura')),
  created_at  timestamptz not null default now(),
  unique (user_id, date, source)   -- one value per source per day; upsert on re-sync
);
create index weights_user_date_idx on public.weights (user_id, date desc);

-- ---------------------------------------------------------------------------
-- Creatine (one row per day)
-- ---------------------------------------------------------------------------
create table public.creatine (
  user_id  uuid not null references auth.users(id) on delete cascade,
  date     date not null,
  grams    numeric not null check (grams >= 0 and grams <= 20),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- Oura daily burn (one row per day; upsert on sync)
-- ---------------------------------------------------------------------------
create table public.oura_daily (
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  active_cal  integer,
  total_burn  integer,
  synced_at   timestamptz not null default now(),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- AI usage events (powers the "AI usage" panel; also useful for future quotas)
-- ---------------------------------------------------------------------------
create table public.ai_usage (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  ts            timestamptz not null default now(),
  provider      text,          -- 'anthropic' | 'openrouter'
  model         text,
  request_type  text,          -- 'text' | 'image' | 'file-import'
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0
);
create index ai_usage_user_ts_idx on public.ai_usage (user_id, ts desc);

-- ---------------------------------------------------------------------------
-- Strength cycle (current mesocycle plan) — kept as JSONB for now since it is
-- still evolving and the app treats it as one object. Normalize later if MCP
-- needs to query inside it.
-- ---------------------------------------------------------------------------
create table public.strength_cycles (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  plan        jsonb not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index strength_cycles_user_idx on public.strength_cycles (user_id, active);

-- ---------------------------------------------------------------------------
-- user_integrations — Oura/Withings OAuth tokens + OpenRouter key.
--
-- Secrets themselves live in Supabase VAULT (encrypted with a key stored OFF the
-- database). This table holds only a *reference* to the Vault secret plus
-- non-secret metadata. No encrypted blobs sit in your app tables.
--
-- RLS enabled with NO policies for anon/authenticated => the client can NEVER
-- read this table. Only the server (service_role, bypasses RLS) touches it, and
-- only the server (postgres/service_role) can read vault.decrypted_secrets.
--
-- Server-side usage (run with the service_role key):
--   -- create/rotate a secret and store its id
--   insert into public.user_integrations (user_id, provider, secret_id, meta)
--   values ($1, 'openrouter',
--           vault.create_secret($2, 'openrouter:'||$1::text), '{"model":"..."}')
--   on conflict (user_id, provider) do update
--     set secret_id = excluded.secret_id, meta = excluded.meta, updated_at = now();
--   -- (to rotate an existing secret instead: select vault.update_secret(secret_id, $2))
--
--   -- read the plaintext secret when calling the provider
--   select decrypted_secret from vault.decrypted_secrets
--   where id = (select secret_id from public.user_integrations
--               where user_id = $1 and provider = 'openrouter');
-- ---------------------------------------------------------------------------
create table public.user_integrations (
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null check (provider in ('oura','withings','openrouter')),
  secret_id   uuid not null,      -- FK-in-spirit to vault.secrets(id); token/key lives there
  meta        jsonb,              -- non-secret: openrouter model, withings base weight/last sync
  updated_at  timestamptz not null default now(),
  primary key (user_id, provider)
);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles          enable row level security;
alter table public.workouts          enable row level security;
alter table public.workout_exercises enable row level security;
alter table public.workout_sets      enable row level security;
alter table public.cardio_sessions   enable row level security;
alter table public.foods             enable row level security;
alter table public.food_favorites    enable row level security;
alter table public.weights           enable row level security;
alter table public.creatine          enable row level security;
alter table public.oura_daily        enable row level security;
alter table public.ai_usage          enable row level security;
alter table public.strength_cycles   enable row level security;
alter table public.user_integrations enable row level security; -- no policies below => client denied

-- Owner-only access. One policy set per table, applied to authenticated users,
-- always with an ownership predicate (never TO authenticated alone).
-- SELECT / INSERT / UPDATE / DELETE spelled out so UPDATE has both USING + WITH CHECK.
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','workouts','workout_exercises','workout_sets','cardio_sessions',
    'foods','food_favorites','weights','creatine','oura_daily','ai_usage','strength_cycles'
  ]
  loop
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id);', t||'_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id);', t||'_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);', t||'_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id);', t||'_delete', t);
  end loop;
end $$;

-- user_integrations intentionally has NO policies: authenticated/anon get zero
-- rows. The server reads/writes it with the service_role key (bypasses RLS), and
-- only the server can read vault.decrypted_secrets to get the plaintext token.
