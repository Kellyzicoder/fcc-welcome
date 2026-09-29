# FCC Welcome Form

A one-page welcome card for first-timers at **Favourite Child Church**, built with Next.js + TypeScript.
Visitors fill it in on their phone (e.g. from a QR code on the welcome table). Their details go into the
`registrations` table in Supabase as **pending** sign-ups, and leaders approve them in the
[FCC Attendance Tracker](https://fcc-attendance.streamlit.app) under **Members → Sign-ups** — nobody is added to the
register until then.

| Asks for | Notes |
|---|---|
| Name (required) | |
| Phone / email | One is needed if they tick "happy for someone to get in touch" |
| Who invited you / how you heard | Saved as *invited by* on approval |
| Prayer / help request | Shown to leaders when approving |
| Happy to be contacted | Unticked → flagged "prefers no contact" |

The visit date is recorded in New Zealand time.

## How it stays safe

- The form uses Supabase's **publishable** key, which is public by design.
- Row Level Security on `registrations` only lets that key **insert** rows with `status = 'pending'`. It can't read,
  edit or delete anything, so nobody can see other people's sign-ups through the form.
- A hidden honeypot field quietly drops most bot submissions.
- Each sign-up gets a random id when Send is first pressed, and keeps it for retries. If the connection drops after
  the row was saved and the visitor presses Send again, the database already has that id, so no duplicate is created
  (the same "idempotency key" idea banks use for payments).
- Never put the Supabase **secret / service_role** key in this project.

## Setup

1. **Supabase** → SQL editor → run the SQL shown in the tracker under *Members → Sign-ups* (safe to run again).
2. **Vercel** → *Add New → Project* → import this repo (framework: Next.js, no build settings to change).
3. In the Vercel project → *Settings → Environment Variables*, add:
   - `NEXT_PUBLIC_SUPABASE_URL` — Supabase → *Project Settings → Data API → Project URL*
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase → *Project Settings → API Keys → Publishable key*
4. Redeploy, open the site, and send a test sign-up. It should appear in the tracker under *Members → Sign-ups*.

## Run locally

```bash
cp .env.example .env.local   # fill in the two values
npm install
npm run dev                  # http://localhost:3000
```

## Files

- `app/page.tsx` — the page (header + form)
- `app/WelcomeForm.tsx` — the form, validation messages, thank-you screen
- `app/registration.ts` — validation and the insert into Supabase (REST API, no extra libraries)
- `app/globals.css` — styles in the church colours, light and dark mode
