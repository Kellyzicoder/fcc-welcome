-- FCC Attendance app: sign-ins and who-can-see-what. Run once in Supabase → SQL editor. Safe to run again.
--
-- Nothing here changes or deletes existing data. It adds two small tables (churches, app_users), some helper
-- functions, and Row Level Security rules so that a signed-in person can only load what their role allows:
--   admin   every church, with names; can add churches and people who may sign in
--   bishop  numbers for every church through church_numbers(); no access to names at all
--   lead    their own church (pastor and follow-up team)
--   team    their own church (ushers)
-- The existing Streamlit site connects as the database owner, so these rules do not affect it.

create table if not exists churches (
  name text primary key,
  livestream text,
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  email text primary key check (email = lower(email)),
  role text not null check (role in ('admin', 'bishop', 'lead', 'team')),
  church text references churches(name) on update cascade,
  name text,
  created_at timestamptz not null default now()
);

alter table members add column if not exists church text;
alter table members add column if not exists age_group text;
alter table members add column if not exists pastor text;
alter table members add column if not exists version integer not null default 1;

-- ---------------------------------------------------------------- who is asking
create or replace function app_home_church() returns text language sql stable security definer set search_path = public as
$$ select coalesce((select value from settings where key = 'home_church'), 'Auckland') $$;

create or replace function app_role() returns text language sql stable security definer set search_path = public as
$$ select role from app_users where email = lower(auth.jwt() ->> 'email') $$;

create or replace function app_church() returns text language sql stable security definer set search_path = public as
$$ select church from app_users where email = lower(auth.jwt() ->> 'email') $$;

-- may the signed-in person see people of this church? (a blank church means the home church)
create or replace function app_can_see(ch text) returns boolean language sql stable security definer set search_path = public as
$$ select case app_role()
     when 'admin' then true
     when 'lead' then coalesce(nullif(trim(ch), ''), app_home_church()) = app_church()
     when 'team' then coalesce(nullif(trim(ch), ''), app_home_church()) = app_church()
     else false end $$;

create or replace function app_me() returns json language sql stable security definer set search_path = public as
$$ select json_build_object('email', lower(auth.jwt() ->> 'email'), 'role', u.role, 'church', u.church, 'name', u.name,
                            'home', app_home_church())
   from (select 1) one left join app_users u on u.email = lower(auth.jwt() ->> 'email') $$;

-- ---------------------------------------------------------------- rules (Row Level Security)
alter table churches enable row level security;
alter table app_users enable row level security;
alter table members enable row level security;
alter table services enable row level security;
alter table attendance enable row level security;
alter table activity_log enable row level security;

drop policy if exists "app: see churches" on churches;
create policy "app: see churches" on churches for select to authenticated using (app_role() is not null);
drop policy if exists "app: admin manages churches" on churches;
create policy "app: admin manages churches" on churches for all to authenticated
  using (app_role() = 'admin') with check (app_role() = 'admin');

drop policy if exists "app: admin manages sign-ins" on app_users;
create policy "app: admin manages sign-ins" on app_users for all to authenticated
  using (app_role() = 'admin') with check (app_role() = 'admin');

drop policy if exists "app: see own church's people" on members;
create policy "app: see own church's people" on members for select to authenticated using (app_can_see(church));
drop policy if exists "app: add people to own church" on members;
create policy "app: add people to own church" on members for insert to authenticated with check (app_can_see(church));
drop policy if exists "app: edit own church's people" on members;
create policy "app: edit own church's people" on members for update to authenticated
  using (app_can_see(church) and app_role() in ('admin', 'lead'))
  with check (app_can_see(church));

drop policy if exists "app: see services" on services;
create policy "app: see services" on services for select to authenticated using (app_role() in ('admin', 'lead', 'team'));
drop policy if exists "app: record a service" on services;
create policy "app: record a service" on services for insert to authenticated with check (app_role() in ('admin', 'lead', 'team'));

drop policy if exists "app: see own church's ticks" on attendance;
create policy "app: see own church's ticks" on attendance for select to authenticated
  using (exists (select 1 from members m where m.id = member_id and app_can_see(m.church)));
drop policy if exists "app: tick own church's people" on attendance;
create policy "app: tick own church's people" on attendance for insert to authenticated
  with check (exists (select 1 from members m where m.id = member_id and app_can_see(m.church)));
drop policy if exists "app: untick own church's people" on attendance;
create policy "app: untick own church's people" on attendance for delete to authenticated
  using (exists (select 1 from members m where m.id = member_id and app_can_see(m.church)));

drop policy if exists "app: write the activity log" on activity_log;
create policy "app: write the activity log" on activity_log for insert to authenticated
  with check (app_role() in ('admin', 'lead', 'team'));
drop policy if exists "app: admin reads the activity log" on activity_log;
create policy "app: admin reads the activity log" on activity_log for select to authenticated using (app_role() = 'admin');

grant select, insert, update, delete on churches, app_users to authenticated;
grant select, insert, update on members to authenticated;
grant select, insert on services to authenticated;
grant select, insert, delete on attendance to authenticated;
grant select, insert on activity_log to authenticated;

-- ---------------------------------------------------------------- numbers for every church (Bishop and admin)
-- Returns counts only. The Bishop's sign-in has no rule that lets it read the members table, so names and phone
-- numbers cannot be loaded with it; this function is the only thing it can call.
create or replace function church_numbers() returns table (
  church text, latest date, present int, adults int, kids int, first_timers int, register int,
  red int, yellow int, missed_this int, trend int[]
) language plpgsql stable security definer set search_path = public as $$
begin
  if app_role() is null or app_role() not in ('admin', 'bishop') then
    raise exception 'not allowed';
  end if;
  return query
  with people as (
    select m.id, coalesce(nullif(trim(m.church), ''), app_home_church()) as ch, m.type,
           lower(coalesce(m.age_group, '')) in ('child', 'kid', 'kids', 'children') as kid,
           least(m.date_joined, m.first_visit) as started, left(m.created_at, 10) as added
    from members m
    where lower(coalesce(m.status, '')) not in ('inactive', 'moved', 'left', 'deceased', 'transferred', 'away')
  ),
  ticks as (select p.ch, p.id, a.service_date from attendance a join people p on p.id = a.member_id
            where a.service_date <= current_date + 1),
  svc as (select t.ch, t.service_date, count(*)::int as n from ticks t group by 1, 2),
  latest as (select s.ch, max(s.service_date) as d from svc s group by 1),
  seen as (select p.id, max(t.service_date) as d from people p left join ticks t on t.id = p.id group by 1),
  streak as (
    select p.id, p.ch,
           (select count(*) from svc s where s.ch = p.ch and s.service_date > coalesce(sn.d, date '0001-01-01')
              and s.service_date >= coalesce(p.started, date '0001-01-01'))::int as missed,
           coalesce(sn.d::text, p.started::text, p.added) as last_sign
    from people p join seen sn on sn.id = p.id
  ),
  active as (select * from streak where last_sign is null or last_sign >= (current_date - 730)::text),
  all_ch as (select name as ch from churches union select ch from people)
  select c.ch, l.d,
         coalesce((select count(*) from ticks t where t.ch = c.ch and t.service_date = l.d), 0)::int,
         coalesce((select count(*) from ticks t join people p on p.id = t.id where t.ch = c.ch and t.service_date = l.d and not p.kid), 0)::int,
         coalesce((select count(*) from ticks t join people p on p.id = t.id where t.ch = c.ch and t.service_date = l.d and p.kid), 0)::int,
         coalesce((select count(*) from ticks t join people p on p.id = t.id where t.ch = c.ch and t.service_date = l.d and p.type = 'first_timer'), 0)::int,
         (select count(*) from active a where a.ch = c.ch)::int,
         (select count(*) from active a where a.ch = c.ch and a.missed >= 5)::int,
         (select count(*) from active a where a.ch = c.ch and a.missed between 3 and 4)::int,
         (select count(*) from active a where a.ch = c.ch and a.missed between 1 and 2)::int,
         coalesce((select array_agg(x.n order by x.service_date) from
                   (select s.service_date, s.n from svc s where s.ch = c.ch order by s.service_date desc limit 12) x), '{}')
  from all_ch c left join latest l on l.ch = c.ch
  order by (c.ch <> app_home_church()), c.ch;
end $$;

revoke all on function church_numbers() from public, anon;
grant execute on function church_numbers(), app_me(), app_role(), app_church(), app_can_see(text), app_home_church() to authenticated;

-- ---------------------------------------------------------------- more screens (second round; safe to run again)
-- The last service each person was ticked at, so the app does not have to load years of ticks to know who
-- belongs in the archive. It runs with the caller's own rules, so a branch only gets its own people.
create or replace function app_last_seen() returns table (member_id text, last_seen date)
language sql stable set search_path = public as
$$ select a.member_id, max(a.service_date) from attendance a group by 1 $$;

-- Anyone who can sign in may change the name shown on their own account (and nothing else about it).
create or replace function app_set_my_name(new_name text) returns text
language plpgsql security definer set search_path = public as $$
declare clean text := left(trim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 80);
begin
  if app_role() is null then raise exception 'not allowed'; end if;
  update app_users set name = nullif(clean, '') where email = lower(auth.jwt() ->> 'email');
  return clean;
end $$;

-- Welcome-form sign-ups belong to the home church: the admin and the home church's leads handle them.
create or replace function app_can_approve() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(app_role() = 'admin' or (app_role() = 'lead' and app_church() = app_home_church()), false) $$;

create or replace function app_who() returns text language sql stable security definer set search_path = public as
$$ select left(coalesce(nullif(trim(u.name), ''), u.email) || ' (' ||
          case u.role when 'admin' then 'Admin' when 'lead' then 'Church admin' when 'bishop' then 'Bishop' else 'Team' end || ')', 80)
   from app_users u where u.email = lower(auth.jwt() ->> 'email') $$;

drop policy if exists "app: see sign-ups" on registrations;
create policy "app: see sign-ups" on registrations for select to authenticated using (app_can_approve());
grant select on registrations to authenticated;

-- Approve a sign-up: one all-or-nothing step. It starts by claiming the sign-up (pending -> approved), so if two
-- people press Approve together only one succeeds and nobody is added twice. Returns the person's id.
create or replace function app_approve_signup(reg uuid, match_id text default null, check_in boolean default true,
                                              at_txt text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r registrations%rowtype; mid text; visit date;
        stamp text := left(coalesce(nullif(trim(at_txt), ''), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')), 40);
        log_id text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  if not app_can_approve() then raise exception 'not allowed'; end if;
  update registrations set status = 'approved' where id = reg and status = 'pending' returning * into r;
  if not found then raise exception 'already handled'; end if;
  visit := coalesce(r.first_visit, (now() at time zone 'Pacific/Auckland')::date);
  if match_id is not null then  -- existing person: only fill in what the form gave, never blank anything
    update members set phone = coalesce(nullif(trim(r.phone), ''), phone), email = coalesce(nullif(trim(r.email), ''), email),
                       invited_by = coalesce(nullif(trim(r.invited_by), ''), invited_by), version = version + 1
     where id = match_id and coalesce(nullif(trim(church), ''), app_home_church()) = app_home_church();
    if not found then raise exception 'that person is not on the home church register'; end if;
    mid := match_id;
  else
    mid := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    insert into members (id, full_name, phone, email, invited_by, type, status, first_visit, follow_up, created_at)
    values (mid, regexp_replace(trim(r.full_name), '\s+', ' ', 'g'), trim(coalesce(r.phone, '')), trim(coalesce(r.email, '')),
            trim(coalesce(r.invited_by, '')), 'first_timer', '', visit,
            'Welcome form' || case when coalesce(r.wants_contact, true) then '' else ' · prefers no contact' end
              || case when trim(coalesce(r.notes, '')) <> '' then ' · ' || trim(r.notes) else '' end, stamp);
  end if;
  if check_in then
    insert into services (service_date, name) values (visit, 'Sunday Service') on conflict (service_date) do nothing;
    insert into attendance (service_date, member_id, checked_at) values (visit, mid, stamp) on conflict do nothing;
    insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
    values (log_id || 't', stamp, 'tick', visit, mid, '', app_who(), 'done');
  end if;
  update registrations set member_id = mid where id = reg;
  insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
  values (log_id, stamp, 'signup_approved', null, mid,
          case when match_id is null then 'new first-timer' else 'matched existing person' end, app_who(), 'done');
  return mid;
end $$;

-- Reject a sign-up. Returns false if someone else already handled it.
create or replace function app_reject_signup(reg uuid, at_txt text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int; stamp text := left(coalesce(nullif(trim(at_txt), ''), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')), 40);
begin
  if not app_can_approve() then raise exception 'not allowed'; end if;
  update registrations set status = 'rejected' where id = reg and status = 'pending';
  get diagnostics n = row_count;
  insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
  values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), stamp, 'signup_rejected', null, null, '', app_who(),
          case when n > 0 then 'done' else 'already' end);
  return n > 0;
end $$;

-- A church's leads can read the activity for their own people (the admin already reads all of it).
drop policy if exists "app: leads read their church's activity" on activity_log;
create policy "app: leads read their church's activity" on activity_log for select to authenticated
  using (app_role() = 'lead' and exists (select 1 from members m where m.id = member_id and app_can_see(m.church)));

-- Reports: the admin can see who receives the daily email, change that list, and read the log of emails sent.
alter table settings enable row level security;
alter table email_log enable row level security;
drop policy if exists "app: admin sees report recipients" on settings;
create policy "app: admin sees report recipients" on settings for select to authenticated
  using (app_role() = 'admin' and key = 'report_recipients');
drop policy if exists "app: admin adds report recipients" on settings;
create policy "app: admin adds report recipients" on settings for insert to authenticated
  with check (app_role() = 'admin' and key = 'report_recipients');
drop policy if exists "app: admin changes report recipients" on settings;
create policy "app: admin changes report recipients" on settings for update to authenticated
  using (app_role() = 'admin' and key = 'report_recipients') with check (app_role() = 'admin' and key = 'report_recipients');
drop policy if exists "app: admin reads the email log" on email_log;
create policy "app: admin reads the email log" on email_log for select to authenticated using (app_role() = 'admin');
-- Each church's list of pastors to choose from (settings key 'pastors:<church>', one name per line): everyone in
-- that church can read it; the admin and that church's leads can change it.
drop policy if exists "app: see own church's pastor list" on settings;
create policy "app: see own church's pastor list" on settings for select to authenticated
  using (key like 'pastors:%' and app_can_see(substr(key, 9)));
drop policy if exists "app: leads add their pastor list" on settings;
create policy "app: leads add their pastor list" on settings for insert to authenticated
  with check (key like 'pastors:%' and app_role() in ('admin', 'lead') and app_can_see(substr(key, 9)));
drop policy if exists "app: leads change their pastor list" on settings;
create policy "app: leads change their pastor list" on settings for update to authenticated
  using (key like 'pastors:%' and app_role() in ('admin', 'lead') and app_can_see(substr(key, 9)))
  with check (key like 'pastors:%' and app_role() in ('admin', 'lead') and app_can_see(substr(key, 9)));
grant select, insert, update on settings to authenticated;
grant select on email_log to authenticated;

-- Rename a church everywhere it is recorded, in one all-or-nothing step: the church itself, its sign-ins, its
-- people, its pastor list, its report list and its email log. Only the admin may do this. The home church keeps its
-- name here because that name is also set outside the database.
create or replace function app_rename_church(old_name text, new_name text) returns text
language plpgsql security definer set search_path = public as $$
declare o text := trim(coalesce(old_name, '')); n text := left(trim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 60);
begin
  if app_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  if n = '' then raise exception 'type the new name'; end if;
  if n ~ '[:*]' then raise exception 'a church name cannot contain : or *'; end if;
  if o = app_home_church() then raise exception 'the home church cannot be renamed here'; end if;
  if not exists (select 1 from churches where name = o) then raise exception 'there is no church called %', o; end if;
  if lower(n) <> lower(o) and exists (select 1 from churches where lower(name) = lower(n)) then raise exception 'there is already a church called %', n; end if;
  if lower(n) = lower(app_home_church()) then raise exception 'there is already a church called %', n; end if;
  update churches set name = n where name = o;                      -- sign-ins follow (on update cascade)
  update members set church = n, version = version + 1 where trim(church) = o;
  delete from settings where key in ('pastors:' || n, 'report_recipients:' || n, 'pastor_group_size:' || n);
  update settings set key = 'pastors:' || n where key = 'pastors:' || o;
  update settings set key = 'report_recipients:' || n where key = 'report_recipients:' || o;
  update settings set key = 'pastor_group_size:' || n where key = 'pastor_group_size:' || o;
  update email_log set kind = split_part(kind, ':', 1) || ':' || n where kind like '%:' || o;
  insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
  values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'rename_church',
          null, null, o || ' → ' || n, app_who(), 'done');
  return n;
end $$;

revoke all on function app_rename_church(text, text) from public, anon;
grant execute on function app_rename_church(text, text) to authenticated;

revoke all on function app_approve_signup(uuid, text, boolean, text), app_reject_signup(uuid, text), app_set_my_name(text) from public, anon;
grant execute on function app_last_seen(), app_set_my_name(text), app_can_approve(), app_who(),
  app_approve_signup(uuid, text, boolean, text), app_reject_signup(uuid, text) to authenticated;

-- ---------------------------------------------------------------- first church and first admin
insert into churches (name) values (app_home_church()) on conflict do nothing;
-- Then add yourself as the first admin (use your own email, lower case):
--   insert into app_users (email, role, name) values ('you@example.com', 'admin', 'Your Name') on conflict (email) do update set role = 'admin';

notify pgrst, 'reload schema';
