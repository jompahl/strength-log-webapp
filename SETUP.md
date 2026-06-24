# Strength Log — multi-user setup guide

This turns the tracker into a real web app your friends just **sign in** to.
No Apps Script, no URL pasting for them — they click "Continue with Google" and go.

You set this up **once**. Friends do nothing but sign in.

---

## How it works (the short version)

- The app is hosted on **Vercel** (free) at a URL you share.
- Friends sign in with Google — this only shares their **name + email** (a clean,
  non-scary consent screen, because the app never touches *their* Google Drive).
- All data is saved to **one Google Sheet that you own**, one row per user, via a
  **service account** (a robot Google identity that writes on your behalf).
- Because friends never grant Drive access, nobody sees an "unverified app" warning.

You will hold everyone's data in your Sheet. Tell your friends that — it's the tradeoff
for zero-setup on their side.

---

## Part A — Google Cloud project (≈10 min, one time)

1. Go to https://console.cloud.google.com and sign in.
2. Top bar ▸ project dropdown ▸ **New Project**. Name it e.g. "Strength Log". Create, then select it.
3. **Enable the Sheets API:** search bar ▸ "Google Sheets API" ▸ **Enable**.

### A1 — Create the service account (writes to your Sheet)
4. Left menu ▸ **APIs & Services ▸ Credentials**.
5. **Create credentials ▸ Service account**. Name it "sheet-writer". Create and continue, then Done.
6. Click the new service account ▸ **Keys** tab ▸ **Add key ▸ Create new key ▸ JSON**.
   A `.json` file downloads. Open it — you'll need two values from it shortly:
   - `client_email`  (looks like `sheet-writer@yourproject.iam.gserviceaccount.com`)
   - `private_key`   (a long block starting with `-----BEGIN PRIVATE KEY-----`)

### A2 — Create the OAuth client (lets friends sign in)
7. **APIs & Services ▸ OAuth consent screen.**
   - User type: **External** ▸ Create.
   - App name, your email for support + developer contact. Save and continue.
   - **Scopes:** you don't need to add any — basic profile/email are included by default. Continue.
   - **Test users:** add your own email (and friends' emails while unverified, if you
     stay in "Testing"). Or click **Publish app** to allow anyone — since we only use
     name/email, this stays in the safe, no-verification lane. Publishing is fine here.
8. **Credentials ▸ Create credentials ▸ OAuth client ID.**
   - Application type: **Web application.**
   - **Authorized JavaScript origins:** add your Vercel URL once you have it
     (e.g. `https://strength-log.vercel.app`). You can add `http://localhost:3000` too for testing.
   - Create. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

---

## Part B — The central Sheet (2 min)

1. Create a new Sheet at https://sheets.new. Name it e.g. "Strength Log Data".
2. From its URL, copy the **Sheet ID** — the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
3. Click **Share** ▸ paste the service account's `client_email` (from step A6) ▸
   give it **Editor** ▸ Send. (This is what lets the robot write to your Sheet.)

---

## Part C — Deploy to Vercel (≈10 min)

1. Make a free account at https://vercel.com (sign in with GitHub is easiest).
2. Put this project folder in a GitHub repo (or use the Vercel CLI / drag-and-drop deploy).
3. In Vercel, **Import** the project. Before deploying, open **Environment Variables**
   and add these four:

   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | the OAuth client ID from A8 |
   | `GOOGLE_SA_EMAIL`  | the service account `client_email` from A6 |
   | `GOOGLE_SA_KEY`    | the full `private_key` from A6 (paste the whole thing, including the BEGIN/END lines) |
   | `SHEET_ID`         | the Sheet ID from B2 |

   Note on `GOOGLE_SA_KEY`: paste it exactly as it appears in the JSON. If Vercel mangles
   the line breaks, the code already converts `\n` back to real newlines, so either form works.

4. **Deploy.** You'll get a URL like `https://strength-log.vercel.app`.
5. Go back to **Part A8** and make sure that exact URL is in **Authorized JavaScript origins**
   for your OAuth client. (If you added it as a guess earlier, confirm it matches.)

That's it. Open the URL, click **Continue with Google**, and you're in. Share the URL
with friends — they just sign in.

---

## What friends experience

1. Open your link.
2. Click **Continue with Google**, pick their account, approve the basic name/email prompt.
3. They land in their own empty tracker (pre-filled with a little demo history the first time).
4. Everything they log saves automatically to your central Sheet, under their own rows.
5. Next time, on any device, signing in loads their data back.

They can use their own Claude account to estimate calories from food photos and to help
format workouts — then type the numbers into the app as before.

---

## Notes & limits

- **Data ownership:** all friends' data lives in your Sheet. Be transparent about that.
- **"Testing" vs "Published" consent screen:** in Testing, only emails you've added as
  test users can sign in (capped at 100). Publishing removes that cap and — because we only
  request name/email — does **not** trigger Google's heavy verification. Publish when ready
  to share widely.
- **The readable tabs:** the app also writes a per-user readable tab so you can browse
  anyone's log directly in the Sheet, alongside the raw `UserData` tab.
- **Security:** the powerful service-account key lives only in Vercel's server environment,
  never in the browser. Friends' browsers only ever hold their own sign-in token, and the
  server verifies it on every request so nobody can impersonate anyone else.
- **Cost:** Vercel's free tier and Google Sheets API free quotas comfortably cover a
  friends-group. No database, no monthly fee.
