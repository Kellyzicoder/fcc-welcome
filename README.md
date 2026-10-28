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
| Server routes | `app/app-config`, `app/app-send`, `app/app-help`, `app/app-live` | Public Supabase settings for the app; sending the attendance report email; Help → Contact the admin; livestream viewer counts for the Livestream widget. |
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

- Sign in with an emailed code or a password: either a passphrase (3+ words, 16+ characters, e.g. "sunday choir sings loud") or 10+ characters with capital and small letters, a number and a symbol. The browser offers to save it.
- Check-in with search, lock and unlock, and adding people without a phone number
- Congregation list with bulk edits, visitor / first-timer / member types and assigned pastors
- Follow-up: yellow and red flags for people missing services in a row (visitors are never flagged)
- Pastor home page with their own people only
- Bacentas (cell groups): each church's Bacentas with their meeting day, shepherd and the pastor who oversees them; take each week's attendance on Check-in (switch Service | Bacenta; a shepherd or pastor gets Bacenta on its usual day), mark weeks it didn't meet, see weeks nobody filled in, and a follow-up list of who missed. Kept apart from services, so it never changes Sunday numbers, follow-up or reports. A shepherd or pastor sign-in takes attendance for the Bacentas with their name on them
- All-churches dashboard: month calendar, church list, charts, *No service was recorded* when a day is empty
- WhatsApp summaries (phones only) and CSV downloads
- Help page with questions by role, and a contact form that emails the admin and lands in the Admin inbox
- Ask a question: 50 ready-made questions (services such as Fathers Day, first-timers by month, females, males, kids, who is missing and more). Each one is a saved SQL query in `app_ask` (`supabase/app_setup.sql`). It is free, has no AI, and never lets anyone type their own SQL. The database's own rules decide what each sign-in sees, and phone numbers are never returned
- Light and dark mode; checks for a newer version each time it opens

## Keeping it safe

- Only Supabase's **publishable** key is used in the browser. Never put the **secret / service_role** key in this
  project or in Vercel.
- `BREVO_API_KEY` and `REPORT_SENDER` are server-only Vercel settings, used by `app-send` and `app-help`.
- `LIVE_STATS_URL` and `LIVE_KEY` are server-only Vercel settings, used by `app-live`. The phone only ever gets the viewer counts, never the live dashboard's password.
- Never commit real names, phone numbers or emails. Add the first admin by typing the one-line `insert` at the
  bottom of `app_setup.sql` into the Supabase SQL editor.
- The welcome form can only *insert pending* sign-ups; it can't read anything. A honeypot field drops most bots,
  and a per-submission id stops duplicates on retry.
- Supabase checks passwords too (Authentication → Sign In / Providers → Email): minimum length **10** and password requirements **No required characters**, so passphrases work; the app asks for the capital, number and symbol whenever the password isn't a passphrase.

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
   - `LIVE_STATS_URL`, `LIVE_KEY`: server-only, for the **Livestream** widget. `LIVE_STATS_URL` is the church-live-dashboard link without `?key=` (e.g. `https://live.<your-name>.workers.dev`); `LIVE_KEY` is that dashboard's `DASHBOARD_KEY`, if it has one. Without them the widget says the livestream isn't connected yet. Other churches don't need anything here: their church admin pastes the church's YouTube channel link in the widget itself (saved by `app_set_livestream`, read through the same dashboard's `/api/youtube`). Facebook and Zoom for other churches still need their own live dashboard.

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
