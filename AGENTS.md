# Strength Log — AI Project Guide

This file is the durable starting context for AI coding agents working in this repository. Read it before changing the project. `ARCHITECTURE.md` explains the current technical shape and `SETUP.md` contains deployment instructions.

## Product

Strength Log is a mobile-friendly, multi-user fitness web app for:

- strength sessions, sets, estimated 1RM, volume, and personal records;
- cardio sessions;
- food, protein, and daily calorie balance;
- body-weight history and trends;
- conversational AI-assisted logging and coaching;
- importing workout history from StrengthLog CSV or an AI-converted text export.

The experience should feel conversational. Profile onboarding and general coaching must accept information across multiple messages, remember earlier answers, and ask only for genuinely missing details. A dated weight statement should log a measurement for that stated date rather than restarting onboarding.

## Current stack

- Frontend: vanilla JavaScript, HTML, and CSS bundled by Vite.
- Backend: CommonJS Vercel serverless functions in `api/`.
- Authentication: Google Identity Services; server functions verify Google ID tokens.
- Primary storage: one operator-owned Google Sheet, keyed by Google `sub`.
- Local cache: `localStorage` key `strengthlog.v2`.
- AI provider: Anthropic through server-side endpoints only.
- Production host: Vercel.
- PWA: manifest and service worker in `public/`.

## Important files

- `index.html`: application markup and dialogs.
- `src/app.js`: current browser-side application logic, rendering, auth, sync, and AI conversation flow.
- `src/styles.css`: application styles.
- `src/domain.js`: exercise muscle groups and strength calorie estimates.
- `src/seedData.js`: starter/demo data.
- `src/importWorkoutCsv.js`: deterministic StrengthLog CSV parser.
- `api/sync.js`: authenticated Google Sheet load/save.
- `api/parse.js`: conversational coaching, profile/weight/workout/food interpretation, and photo analysis.
- `api/import-workouts.js`: AI fallback for unknown workout-export formats.
- `api/oura.js`, `api/_oura.js`: Oura OAuth and daily calorie data.
- `api/withings.js`, `api/_withings.js`, `api/withings-webhook.js`: Withings OAuth, weight sync, and notifications.
- `scripts/dev-server.mjs`: local Vite plus API-function server.
- `public/privacy/index.html`, `public/terms/index.html`: public legal pages; update them whenever data handling changes.

## Data and sync model

The frontend payload is assembled by `syncPayload()` and restored by `applyPayload()` in `src/app.js`. Important fields include:

- `entries`: strength and cardio entries;
- `food`, `hiddenFood`;
- `weights`;
- `profile`;
- `aiUsage`;
- `ouraDaily`;
- `withingsLastSync`, `withingsBaseWeight`;
- `coachId`, `seedImported`.

`api/sync.js` stores each user's JSON across cells in the `UserData` sheet because a Google Sheets cell has a 50,000-character limit. It also creates a readable per-user mirror as a best-effort operation.

Never trust a user ID supplied directly by the browser. Verify the Google ID token and use its `sub`. Secrets and third-party OAuth tokens must remain server-side and encrypted before storage.

## Existing integrations and behavior

### Oura

- Uses the `daily` scope.
- OAuth tokens are AES-256-GCM encrypted in the hidden `OuraAuth` sheet.
- Opening Calories performs an automatic refresh.
- On a date with Oura data, Oura total burn is the calorie-output source. Until that date is available, the app displays its existing estimate.
- Oura API data must not be sent to Anthropic or included in AI prompts.

### Withings

- Uses `user.metrics` for scale measurements.
- Tokens are encrypted in the hidden `WithingsAuth` sheet.
- Webhooks automatically import new measurements; opening relevant views provides a backup refresh.
- Weight dates must preserve the full calendar year. Never merge or compare measurements using only month/day.

### Workout imports

- The standard import is specifically labeled for StrengthLog and parsed locally by `src/importWorkoutCsv.js`.
- Unknown text-based formats can be sent to `api/import-workouts.js`, which treats file contents as untrusted data and validates the model's canonical output.
- Imported entries must be deduplicated and must not invent workouts, sets, dates, reps, or loads.

## Product conventions

- Dates are local calendar dates in `YYYY-MM-DD`; avoid UTC conversion that moves a measurement or workout to another day.
- Weight values display with one decimal place.
- Trend controls offer Week, Month, 6 months, and Year. Strength and Cardio default to 6 months; Weight defaults to Week.
- Changes save locally first and then debounce to cloud sync after the initial pull.
- The app must still support local-only development when Google or server configuration is absent.
- Keep mobile layouts usable and account integration states understandable without developer terminology.
- Do not silently replace or delete user-entered records when merging third-party data.
- Update privacy, terms, setup, and environment examples whenever an integration or data flow changes.

## Development and verification

From the repository root:

```bash
npm install
npm run dev
npm run build
```

There is currently no automated test suite. For changes, at minimum:

1. run syntax checks for changed server files with `node --check`;
2. run `npm run build`;
3. test the affected flow in the browser, including a narrow/mobile viewport when UI changes;
4. run `git diff --check`;
5. inspect `git status` and avoid touching unrelated user changes.

Do not commit or push unless the user asks. Never commit secrets or `.env.local`.

## Future feature — Strava cardio sync (PAUSED)

Status: deliberately not implemented. There must be no Strava toggle, endpoint, dependency, environment variable, or production data flow until the owner explicitly asks to resume this feature.

### Intended outcome

Allow a signed-in user to connect Strava from Account and import supported cardio activities into the Cardio history. Sync automatically when Cardio opens and use an app-wide webhook for later creates, updates, deletions, and deauthorization.

### Proposed scope

- Request only `activity:read`; do not request private activities unless the product owner explicitly expands the scope.
- Import up to one year of public cardio history.
- Map runs, rides, walks, hikes, swims, rows, and similar sports to canonical cardio entries.
- Do not import `WeightTraining`, `Crossfit`, `Workout`, `Yoga`, or `Pilates` as incomplete cardio/strength records.
- Store source metadata such as `source: "strava"` and `stravaActivityId` for stable upserts and deletion.
- Show connection status, last sync, a toggle, and a manual sync action in Account.
- Reconcile on Cardio open so a missed webhook does not leave stale history.
- Disconnecting or Strava deauthorization must delete encrypted credentials and all Strava-sourced records.

Suggested normalized fields:

```json
{
  "_id": "strava-123",
  "kind": "cardio",
  "date": "YYYY-MM-DD",
  "activity": "Run",
  "distance_km": 5.0,
  "duration_min": 30,
  "pace_min_km": 6,
  "calories": 0,
  "elevation_m": 50,
  "note": "Morning Run · Synced from Strava",
  "source": "strava",
  "stravaActivityId": "123"
}
```

### Proposed server shape

- `api/_strava.js`: configuration, Google-token verification, encrypted token storage, refresh, activity normalization, and Google Sheet mutation helpers.
- `api/strava.js`: OAuth callback and authenticated `status`, `connect`, `sync`, and `disconnect` actions.
- `api/strava-webhook.js`: subscription validation and fast event acknowledgement, with background processing where supported.
- Hidden sheet `StravaAuth`: user `sub`, Strava athlete ID, encrypted token JSON, and update timestamp.
- AES-256-GCM encryption using a dedicated key; never reuse another provider's encryption key.
- One Strava webhook subscription per API application; record and validate its subscription ID.

Expected environment variables:

```text
STRAVA_CLIENT_ID
STRAVA_CLIENT_SECRET
STRAVA_REDIRECT_URI=https://YOUR-DOMAIN/api/strava
STRAVA_TOKEN_ENCRYPTION_KEY
STRAVA_WEBHOOK_URI=https://YOUR-DOMAIN/api/strava-webhook
STRAVA_WEBHOOK_VERIFY_TOKEN
```

### Critical policy constraint

Before implementation, re-check the current official Strava API Agreement and documentation. As of the June 2026 policy reviewed during planning, Strava data and derived information must not be supplied to or used by AI systems in any manner, including prompts, conversation context, retrieval, inference, training, fine-tuning, evaluation, or benchmarking.

Therefore the implementation must enforce a hard data boundary:

- filter every `source === "strava"` entry out of `dayContext()`, `historyContext()`, and any future AI payload;
- do not use Strava data in combined calorie-balance calculations or other derived analytics unless the then-current policy clearly permits it;
- add regression tests for these exclusions before launch;
- disclose collection, retention, AI exclusion, and deletion in the Privacy Policy and Terms.

### Resume checklist

1. Verify current Strava OAuth, webhook, rate-limit, retention, display, and AI restrictions using official documentation.
2. Register the Strava API application and callback domain.
3. Implement encrypted OAuth and status/disconnect behavior.
4. Implement one-year import, normalization, deduplication, and reconciliation.
5. Add webhook validation and create/update/delete/deauthorization handling.
6. Add Account UI and Cardio auto-refresh.
7. Prove Strava data cannot enter any AI request or disallowed derived calculation.
8. Update `.env.example`, `SETUP.md`, `ARCHITECTURE.md`, Privacy Policy, and Terms.
9. Test OAuth return, refresh-token rotation, missed webhooks, deletion, reconnect, and mobile UI.
10. Build, review the complete diff, then commit and deploy only when requested.
