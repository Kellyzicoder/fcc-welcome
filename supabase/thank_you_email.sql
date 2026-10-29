-- Thank-you email for first-timers
-- The morning after someone fills in the welcome form, a scheduled job (Vercel Cron → /first-timer-thanks)
-- emails them a thank-you. Only people who gave an email and ticked "I'm happy for someone from FCC to get in touch".
--
-- How the job gets in without a person's sign-in:
--   the job sends a long random key (CRON_SECRET on Vercel). The database only keeps a fingerprint (SHA-256) of it
--   in a private table the website can't reach, and the two functions below refuse anyone without the right key.
--   No secret Supabase key is needed on Vercel.
--
-- Safe to run again. After running, set the key once with (replace the text, keep the quotes):
--   insert into private.job_keys (name, key_hash)
--   values ('thankyou', encode(extensions.digest('PASTE-CRON_SECRET-HERE', 'sha256'), 'hex'))
--   on conflict (name) do update set key_hash = excluded.key_hash;

alter table public.registrations add column if not exists thanks_sent_at timestamptz;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.job_keys (name text primary key, key_hash text not null);
revoke all on private.job_keys from public, anon, authenticated;

create or replace function private.job_key_ok(job text, given text)
returns boolean language sql stable security definer set search_path = private, extensions
as $$ select exists (select 1 from private.job_keys k
                     where k.name = job and given is not null and length(given) >= 32
                       and k.key_hash = encode(extensions.digest(given, 'sha256'), 'hex')) $$;
revoke all on function private.job_key_ok(text, text) from public, anon, authenticated;

-- Who is due a thank-you: visited before today (NZ time), within the last 3 days (so a missed run catches up,
-- but old sign-ups never get a surprise email), gave an email, said yes to contact, not rejected, not sent yet.
create or replace function public.app_thankyou_due(job_key text)
returns table (id uuid, full_name text, email text, first_visit date)
language plpgsql stable security definer set search_path = public
as $$
declare today date := (now() at time zone 'Pacific/Auckland')::date;
begin
  if not private.job_key_ok('thankyou', job_key) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select r.id, r.full_name, r.email, r.first_visit
    from registrations r
    where r.thanks_sent_at is null
      and r.wants_contact is true
      and coalesce(trim(r.email), '') <> ''
      and coalesce(r.status, 'pending') <> 'rejected'
      and r.first_visit < today
      and r.first_visit >= today - 3
    order by r.created_at
    limit 100;
end $$;

-- Marks people as sent so nobody gets the email twice.
create or replace function public.app_thankyou_mark(job_key text, ids uuid[])
returns integer
language plpgsql volatile security definer set search_path = public
as $$
declare n integer;
begin
  if not private.job_key_ok('thankyou', job_key) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update registrations set thanks_sent_at = now() where id = any(ids) and thanks_sent_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.app_thankyou_due(text) from public;
revoke all on function public.app_thankyou_mark(text, uuid[]) from public;
grant execute on function public.app_thankyou_due(text) to anon;
grant execute on function public.app_thankyou_mark(text, uuid[]) to anon;
