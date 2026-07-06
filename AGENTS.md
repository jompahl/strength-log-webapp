# Strength Log — AI Project Guide

This file is the durable starting context for AI coding agents working in this repository. Read it before changing the project. `ARCHITECTURE.md` explains the current technical shape and `SETUP.md` contains deployment instructions.

## Product

Strength Log is a mobile-friendly, multi-user fitness web app for:

- strength sessions, sets, estimated 1RM, volume, and personal records;
- cardio sessions;
- food, reusable food favorites, protein, creatine, and daily calorie balance;
- body-weight history and trends;
- conversational AI-assisted logging and coaching;
- importing workout history from StrengthLog CSV or an AI-converted text export.

The experience should feel conversational. Profile onboarding and general coaching must accept information across multiple messages, remember earlier answers, and ask only for genuinely missing details. A dated weight statement should log a measurement for that stated date rather than restarting onboarding. Food logging must likewise preserve an explicitly stated or relative day instead of silently assigning today. When the AI proposes a strength workout log, it should give 1–3 sentences of specific feedback using recent exercise baselines when available, without inventing progress or PRs.

## Current stack

- Frontend: vanilla JavaScript, HTML, and CSS bundled by Vite.
- Backend: CommonJS Vercel serverless functions in `api/`.
- Authentication: Google Identity Services for initial sign-in, followed by a signed HttpOnly first-party session with a sliding seven-day inactivity expiry.
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
- `api/session.js`, `api/_auth.js`: Google credential exchange and shared seven-day session verification.
- `api/parse.js`: conversational coaching, profile/weight/workout/food interpretation, and photo analysis.
- `api/import-workouts.js`: AI fallback for unknown workout-export formats.
- `api/oura.js`, `api/_oura.js`: Oura OAuth and daily calorie data.
- `api/withings.js`, `api/_withings.js`, `api/withings-webhook.js`: Withings OAuth, weight sync, and notifications.
- `scripts/dev-server.mjs`: local Vite plus API-function server.
- `public/privacy/index.html`, `public/terms/index.html`: public legal pages; update them whenever data handling changes.

## Data and sync model

The frontend payload is assembled by `syncPayload()` and restored by `applyPayload()` in `src/app.js`. Important fields include:

- `entries`: strength and cardio entries;
- `food`, `foodFavorites`, `hiddenFood`;
- `creatine`: one daily creatine total per date, capped at 20 g;
- `weights`;
- `profile`;
- `aiUsage`;
- `ouraDaily`;
- `withingsLastSync`, `withingsBaseWeight`;
- `coachId`, `seedImported`.

`api/sync.js` stores each user's JSON across cells in the `UserData` sheet because a Google Sheets cell has a 50,000-character limit. It also creates a readable per-user mirror as a best-effort operation.

Never trust a user ID supplied directly by the browser. Verify the Google ID token or signed first-party session and use its `sub`. Secrets and third-party OAuth tokens must remain server-side and encrypted before storage.

The browser must not persist Google ID tokens. After initial Google verification, `api/session.js` sets a signed, HttpOnly, SameSite login cookie. Protected endpoints accept the shared session through `verifyRequestUser()`. Opening the app renews the cookie; seven inactive days or explicit sign-out ends the session. `SESSION_SECRET` is preferred, with a domain-separated key derived from `GOOGLE_SA_KEY` as the deployment-compatible fallback.

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
- The Strength tab has a user-managed current mesocycle (`strengthCycle`: name, start date, planned weeks). It shows the current week and fully completed weeks, syncs with the user's data, and is included in AI history context so next-workout recommendations account for cycle phase and sessions completed within it.
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

## Future feature — direct StrengthLog sync (PAUSED)

Status: awaiting a response from the StrengthLog team about public, private, or partner API access. Do not reverse engineer StrengthLog's private endpoints, store StrengthLog account passwords, or implement an unofficial scraper. The existing CSV importer remains the supported integration.

### Intended outcome

Let a user explicitly connect their StrengthLog account and automatically synchronize completed workouts, including workout name and date, exercises, set order, reps, load, warm-up state, duration, comments, and stable source identifiers. Repeated synchronization must upsert changed workouts and remove or clearly reconcile deleted workouts without duplicating history.

### Prerequisite

Obtain written confirmation and official documentation from StrengthLog covering:

- authentication, preferably OAuth rather than user credentials;
- workout-list and workout-detail endpoints;
- stable workout, exercise, and set identifiers;
- incremental sync, update timestamps, deletion signals, and webhooks if available;
- rate limits, retention requirements, permitted data uses, and branding requirements;
- production-access approval and whether the integration may serve multiple users.

Do not begin implementation until the owner explicitly resumes the feature and provides the official API information.

### Preferred design if API access is granted

- Add a StrengthLog connection card in Account with status, toggle, last sync, and manual refresh.
- Keep provider logic in dedicated server files such as `api/strengthlog.js` and `api/_strengthlog.js`.
- Encrypt access and refresh tokens server-side with a dedicated encryption key and hidden auth sheet.
- Normalize provider workouts into the existing strength-entry schema while preserving `source: "strengthlog"` and stable provider IDs.
- Import an initial bounded history, then use incremental timestamps or webhooks for later changes.
- Reconcile by provider ID; never deduplicate solely by workout name or calendar date.
- Disconnecting must revoke access when supported and remove credentials. Ask the product owner whether imported history should also be removed or retained as a user-controlled copy.
- Update Privacy Policy, Terms, setup documentation, environment examples, and tests before launch.

### Fallbacks if no API is available

1. Continue the existing StrengthLog CSV workflow. Improve it with incremental re-import, stable `importId` matching, previews, and a clear summary of added, updated, skipped, and duplicate workouts.
2. Consider Apple Health or Android Health Connect only as a separate native-app project. A browser/PWA cannot directly read HealthKit or Health Connect, and their workout records may not preserve detailed exercises, sets, reps, and loads. Validate exported fields before choosing this route.

### Resume checklist

1. Review StrengthLog's reply and official technical/legal documentation.
2. Confirm exactly which workout fields and historical range are available.
3. Decide conflict behavior for edits made in both apps.
4. Design OAuth, encrypted token storage, refresh, revocation, and deletion.
5. Add canonical mapping and idempotent upsert/delete logic.
6. Add Account UI, initial import progress, background refresh, and useful error states.
7. Test duplicate imports, edited/deleted workouts, token expiry, reconnect, partial failures, time zones, kilograms/pounds, timed sets, bodyweight, assistance, and custom exercises.
8. Update legal and setup documents, build, review, and deploy only when requested.
