# Strength Log Architecture

## Current shape

- `index.html` holds the app markup and loads the Vite module entry.
- `src/styles.css` holds the extracted app styles.
- `src/app.js` holds the browser-side behavior for auth, charts, logging, sync, and coach chat.
- `src/seedData.js` holds the starter/demo data.
- `src/domain.js` holds shared domain constants such as exercise muscle groups and workout calorie estimates.
- `api/sync.js` verifies Google sign-in tokens and syncs each user's data to the central Google Sheet.
- `api/parse.js` verifies Google sign-in tokens and calls Anthropic for chat/photo parsing.
- `api/oura.js` handles Oura OAuth, connection status, disconnects, and Daily Activity sync.
- Oura access and refresh tokens are AES-256-GCM encrypted in the hidden `OuraAuth` sheet; decrypted tokens never reach the browser.
- Withings access and refresh tokens are AES-256-GCM encrypted in the hidden `WithingsAuth` sheet. Weight webhooks are authenticated with a private callback secret, merged into each user's cloud weight history, and backed up by an in-app refresh.
- Synced Oura Daily Activity totals are stored in each user's regular data payload and replace estimated calorie output for matching days.
- AI usage is stored per user in the synced payload as `aiUsage`, with timestamp, provider, model, request type, and token counts returned by Anthropic.

## Recommended next steps

1. Split `src/app.js` by feature: auth, sync, strength, cardio, calories, coach chat, and shared calculations.
2. Add an AI settings screen with provider choice, monthly limits, and clearer cost estimates.
3. Move AI usage tracking fully server-side before enforcing hard quotas.
4. When friend usage grows, move source-of-truth data from Google Sheets to Postgres/Supabase and keep Sheets as export/admin mirror.

## AI billing direction

ChatGPT and Claude subscriptions do not normally cover API usage inside a separate app. For friends, the practical options are:

- App quota: you pay for one API account, but each user gets a monthly allowance.
- Bring your own API key: users paste their own OpenAI/Anthropic API key, stored encrypted server-side.
- Paid credits: users pay you through Stripe, and the app continues using your provider account.

Do not store user API keys in browser storage. If BYOK is added, save encrypted keys only on the server and route all AI calls through `api/parse.js` or a dedicated AI gateway.
