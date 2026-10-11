-- TEST DATABASE ONLY. Step 1 of 3 for a separate Supabase project used by Vercel previews.
-- Creates the tables the Streamlit app normally creates on the real database. Safe to run again.
-- Then: step 2 = run app_setup.sql, step 3 = run test_2_sample_data.sql.

create table if not exists members (
  id text primary key, full_name text not null, phone text, email text, group_name text, role text,
  status text, type text default 'member', date_joined date, first_visit date, invited_by text,
  follow_up text, created_at text);
create table if not exists services (service_date date primary key, name text);
create table if not exists attendance (
  service_date date not null references services(service_date) on delete cascade,
  member_id text not null references members(id) on delete cascade,
  checked_at text, primary key (service_date, member_id));
create index if not exists attendance_member on attendance(member_id);
create table if not exists settings (key text primary key, value text);
create table if not exists email_log (
  id text primary key, kind text, report_date date, sent_at text, recipients text, ok boolean, detail text);
create table if not exists activity_log (
  id text primary key, at text not null, kind text not null, service_date date, member_id text,
  detail text, by_name text, result text);
create index if not exists activity_log_at on activity_log(at);
alter table members add column if not exists version integer not null default 1;

-- Sign-ups from the welcome form (same as the Streamlit setup SQL).
create table if not exists registrations (
  id uuid primary key default gen_random_uuid(),
  full_name text, phone text, email text, invited_by text, first_visit date, notes text,
  wants_contact boolean default true, status text default 'pending', member_id text,
  created_at timestamptz not null default now());
grant insert on registrations to anon;

alter table members enable row level security;
alter table services enable row level security;
alter table attendance enable row level security;
alter table settings enable row level security;
alter table email_log enable row level security;
alter table activity_log enable row level security;
alter table registrations enable row level security;
