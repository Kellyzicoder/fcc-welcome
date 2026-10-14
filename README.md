# FCC Attendance app

The attendance app for **Favourite Child Church**: check-in on a phone, the congregation list, missed-service
follow-up, pastor and church dashboards, and the welcome form for first-timers. It shares one Supabase database
with the [FCC Attendance Tracker](https://fcc-attendance.streamlit.app) (Streamlit).

**Live:** <https://fcc-welcome.vercel.app/app/index.html> · **Welcome form:** <https://fcc-welcome.vercel.app>

> The repo is still called `fcc-welcome` because it started as the welcome form. Keep the Vercel project name as it
> is: it sets the web address, which is saved in people's Home Screen icons and in Supabase's sign-in settings.

## What's in it

| Part | Where | What it does |
|---|---|---|
| Phone app | `public/app/` | Plain HTML + JavaScript, no build step. Installable with *Add to Home Screen*. |
| Welcome form | `app/page.tsx`, `app/WelcomeForm.tsx`, `app/registration.ts` | First-timers fill it in (e.g. from a QR code). Sign-ups wait as *pending* until a leader approves them. |
| Server routes | `app/app-config`, `app/app-send`, `app/app-help`, `app/app-chat` | Public Supabase settings for the app; sending the attendance report email; Help → Contact the admin; Help → Ask the helper. |
| Database rules | `supabase/app_setup.sql` | Tables, helper functions and Row Level Security. Safe to run again. |
| Test database | `supabase/test_1_tables.sql`, `supabase/test_2_sample_data.sql` | A separate Supabase project with made-up people, used by Vercel previews. |
| Guide | `docs/FCC-Attendance-Guide.pdf` | How it fits together, design decisions, common fixes. |

### Who sees what

| Role | Sees |
|---|---|
| Admin | Every church; Admin page (messages, sign-ins, churches, database space) |
| Bishop | All churches as numbers and dashboards, no names |
| Church admin | Everything for their own church |
| Team (usher) | Check-in and their church's people |
| Pastor | Only the people assigned to them; can tick them in |

**The database enforces this, not the app.** Every request uses the person's own sign-in, and Row Level Security
in `supabase/app_setup.sql` decides what comes back.

### Features

- Sign in with an emailed code or a password (10+ characters, capital and small letters, a number and a symbol)
- Check-in with search, lock and unlock, and adding people without a phone number
- Congregation list with bulk edits, visitor / first-timer / member types and assigned pastors
- Follow-up: yellow and red flags for people missing services in a row (visitors are never flagged)
- Pastor home page with their own people only
- All-churches dashboard: month calendar, church list, charts, *No service was recorded* when a day is empty
- WhatsApp summaries (phones only) and CSV downloads
- Help page with questions by role, and a contact form that emails the admin and lands in the Admin inbox
- Ask the helper: a chat on the Help page that answers how-to questions (it never sees names, numbers or attendance)
- Light and dark mode; checks for a newer version each time it opens

## Keeping it safe

- Only Supabase's **publishable** key is used in the browser. Never put the **secret / service_role** key in this
  project or in Vercel.
- `BREVO_API_KEY` and `REPORT_SENDER` are server-only Vercel settings, used by `app-send` and `app-help`.
- `ANTHROPIC_API_KEY` is a server-only Vercel setting, used by `app-chat` (Ask the helper). The Claude API is billed
  separately from a Claude chat subscription. Without it, the helper says it isn't set up and points to Contact the admin.
- Never commit real names, phone numbers or emails. Add the first admin by typing the one-line `insert` at the
  bottom of `app_setup.sql` into the Supabase SQL editor.
- The welcome form can only *insert pending* sign-ups; it can't read anything. A honeypot field drops most bots,
  and a per-submission id stops duplicates on retry.
- Password rules are set in Supabase too (Authentication → Email), so they hold even outside the app.

## Setup

1. **Supabase** → SQL editor → run `supabase/app_setup.sql`. Run it again whenever it changes, in both the real
   project (fcc-church) and the test project (fcc-test). If Supabase warns about RLS on a table called `u`, choose
   *Run without RLS*: `u` is a variable inside a function, not a table.
2. **Supabase** → Authentication → URL Configuration: set the Site URL to the app's address and add it to Redirect
   URLs, so emailed sign-in links open the app.
3. **Vercel** → import this repo (Next.js, no build settings to change).
4. **Vercel** → Settings → Environment Variables (type *Config*, not *Secret*):
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: Production = fcc-church, Preview = fcc-test
   - `BREVO_API_KEY`, `REPORT_SENDER`: server-only, for report and help emails

## Working on it

- Make changes on the `design-preview` branch. Vercel builds a preview on the **test** database.
- Open a pull request into `main`; merging it puts the change live.
- The phone app has no build step: edit `public/app/app.js` and `public/app/index.html` directly.
- `vercel.json` tells browsers to always check for new app files, and the app reloads itself when a newer
  version is out.

### Run locally

```bash
cp .env.example .env.local   # fill in the two Supabase values
npm install
npm run dev                  # http://localhost:3000 (app at /app/index.html)
```
