-- FCC Attendance app: sign-ins and who-can-see-what. Run once in Supabase → SQL editor. Safe to run again.
--
-- Nothing here changes or deletes existing data. It adds two small tables (churches, app_users), some helper
-- functions, and Row Level Security rules so that a signed-in person can only load what their role allows:
--   admin   every church, with names; can add churches and people who may sign in
--   bishop  numbers for every church through church_numbers(); no access to names at all
--   lead    their own church (pastor and follow-up team)
--   team    their own church (ushers)
--   pastor  only the people assigned to them (by the name in app_users.pastor): see and tick, nothing else
-- The existing Streamlit site connects as the database owner, so these rules do not affect it.

create table if not exists churches (
  name text primary key,
  livestream text,
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  email text primary key check (email = lower(email)),
  role text not null check (role in ('admin', 'bishop', 'lead', 'team', 'pastor')),
  church text references churches(name) on update cascade,
  name text,
  created_at timestamptz not null default now()
);

-- Pastor sign-ins: the role is allowed, and each one is linked to their name on the church's pastor list.
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (role in ('admin', 'bishop', 'lead', 'team', 'pastor'));
alter table app_users add column if not exists pastor text;
-- A lead pastor is a church admin with this title (they also get the Pastor view); Role 3 is a spare role saved for later.
alter table app_users add column if not exists title text;
alter table app_users add column if not exists role3 text;

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

-- A pastor's own people: in the pastor's church, with the pastor's name among the person's pastors (comma-separated,
-- any capitals or spacing). Everyone else gets false here.
create or replace function app_pastor_name() returns text language sql stable security definer set search_path = public as
$$ select lower(regexp_replace(trim(pastor), '\s+', ' ', 'g')) from app_users
   where email = lower(auth.jwt() ->> 'email') and role = 'pastor' and nullif(trim(pastor), '') is not null $$;
create or replace function app_is_mine(ch text, pastors text) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(app_role() = 'pastor' and coalesce(nullif(trim(ch), ''), app_home_church()) = app_church()
     and exists (select 1 from unnest(string_to_array(coalesce(pastors, ''), ',')) x
                 where lower(regexp_replace(trim(x), '\s+', ' ', 'g')) = app_pastor_name()), false) $$;

create or replace function app_me() returns json language sql stable security definer set search_path = public as
$$ select json_build_object('email', lower(auth.jwt() ->> 'email'), 'role', u.role, 'church', u.church, 'name', u.name,
                            'home', app_home_church(), 'pastor', u.pastor, 'title', u.title, 'role3', u.role3)
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
create policy "app: see services" on services for select to authenticated using (app_role() in ('admin', 'lead', 'team', 'pastor'));
drop policy if exists "app: record a service" on services;
create policy "app: record a service" on services for insert to authenticated with check (app_role() in ('admin', 'lead', 'team', 'pastor'));

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
  with check (app_role() in ('admin', 'lead', 'team', 'pastor'));
drop policy if exists "app: admin reads the activity log" on activity_log;
create policy "app: admin reads the activity log" on activity_log for select to authenticated using (app_role() = 'admin');

-- Pastors: see and tick only their own people. They cannot add, edit or delete anyone (no rules for that).
drop policy if exists "app: pastors see their own people" on members;
create policy "app: pastors see their own people" on members for select to authenticated using (app_is_mine(church, pastor));
drop policy if exists "app: pastors see their people's ticks" on attendance;
create policy "app: pastors see their people's ticks" on attendance for select to authenticated
  using (exists (select 1 from members m where m.id = member_id and app_is_mine(m.church, m.pastor)));
drop policy if exists "app: pastors tick their people" on attendance;
create policy "app: pastors tick their people" on attendance for insert to authenticated
  with check (exists (select 1 from members m where m.id = member_id and app_is_mine(m.church, m.pastor)));
drop policy if exists "app: pastors untick their people" on attendance;
create policy "app: pastors untick their people" on attendance for delete to authenticated
  using (exists (select 1 from members m where m.id = member_id and app_is_mine(m.church, m.pastor)));

grant select, insert, update, delete on churches, app_users to authenticated;
-- Gender (Female / Male / blank) for the Congregation's Show and Sort. Someone's pastors are kept comma-separated in "pastor".
alter table members add column if not exists gender text;
alter table members add column if not exists address text;  -- home address (Congregation → Import people, and Edit)
grant select, insert, update on members to authenticated;
-- Deleting someone from the register (their ticks go with them): the admin, or that church's admin.
drop policy if exists "app: church admins delete people" on members;
create policy "app: church admins delete people" on members for delete to authenticated
  using (app_role() in ('admin', 'lead') and app_can_see(church));
grant delete on members to authenticated;
grant select, insert on services to authenticated;
-- A service's title can be changed ("Midweek Service", "Prayer Meeting") by anyone who does check-in.
drop policy if exists "app: rename a service" on services;
create policy "app: rename a service" on services for update to authenticated
  using (app_role() in ('admin', 'lead', 'team')) with check (app_role() in ('admin', 'lead', 'team'));
grant update (name) on services to authenticated;
grant select, insert, delete on attendance to authenticated;
grant select, insert on activity_log to authenticated;

-- ---------------------------------------------------------------- two (or more) services on one day
-- A church can split a day into services (e.g. 9am and 11am). attendance still holds one tick per person per day, so every
-- day total, report and the Streamlit tracker stay as they are (someone at both services counts once). service_parts names
-- each service of that day for that church; service_ticks says which of the day's services each person came to.
create table if not exists service_parts (
  church text not null references churches(name) on update cascade on delete cascade,
  service_date date not null,
  part smallint not null check (part between 1 and 5),
  name text not null default '' check (length(name) <= 60),
  primary key (church, service_date, part));
create table if not exists service_ticks (
  service_date date not null,
  part smallint not null check (part between 1 and 5),
  member_id text not null references members(id) on delete cascade,
  checked_at text,
  primary key (service_date, part, member_id));
alter table service_parts enable row level security;
alter table service_ticks enable row level security;
drop policy if exists "app: see a day's services" on service_parts;
create policy "app: see a day's services" on service_parts for select to authenticated
  using (app_can_see(church) or (app_role() = 'pastor' and church = app_church()));
drop policy if exists "app: split a day into services" on service_parts;
create policy "app: split a day into services" on service_parts for all to authenticated
  using (app_role() in ('admin', 'lead', 'team') and app_can_see(church))
  with check (app_role() in ('admin', 'lead', 'team') and app_can_see(church));
drop policy if exists "app: see own church's service ticks" on service_ticks;
create policy "app: see own church's service ticks" on service_ticks for select to authenticated
  using (exists (select 1 from members m where m.id = member_id and (app_can_see(m.church) or app_is_mine(m.church, m.pastor))));
drop policy if exists "app: tick own church's people at a service" on service_ticks;
create policy "app: tick own church's people at a service" on service_ticks for insert to authenticated
  with check (exists (select 1 from members m where m.id = member_id and (app_can_see(m.church) or app_is_mine(m.church, m.pastor))));
drop policy if exists "app: untick own church's people at a service" on service_ticks;
create policy "app: untick own church's people at a service" on service_ticks for delete to authenticated
  using (exists (select 1 from members m where m.id = member_id and (app_can_see(m.church) or app_is_mine(m.church, m.pastor))));
grant select, insert, update, delete on service_parts to authenticated;
grant select, insert, delete on service_ticks to authenticated;

-- ---------------------------------------------------------------- numbers for every church (Bishop and admin)
-- Returns counts only. The Bishop's sign-in has no rule that lets it read the members table, so names and phone
-- numbers cannot be loaded with it; this function is the only thing it can call.
-- Called with a date it gives the numbers as they stood after that day's services (for sharing an earlier day).
drop function if exists church_numbers();
create or replace function church_numbers(upto date default null) returns table (
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
            where a.service_date <= coalesce(upto, current_date + 1)),
  svc as (select t.ch, t.service_date, count(*)::int as n from ticks t group by 1, 2),
  latest as (select s.ch, max(s.service_date) as d from svc s group by 1),
  seen as (select p.id, max(t.service_date) as d from people p left join ticks t on t.id = p.id group by 1),
  streak as (
    select p.id, p.ch,
           -- only Sunday services count as missed; midweek services still count as being seen
           -- visitors are never chased, so they never count as missing
           case when p.type = 'visitor' then 0 else
           (select count(*) from svc s where s.ch = p.ch and s.service_date > coalesce(sn.d, date '0001-01-01')
              and s.service_date >= coalesce(p.started, date '0001-01-01') and extract(dow from s.service_date) = 0)::int end as missed,
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

-- Each church's last 12 services up to a day (today when not given), as counts only (adults, kids, first-timers,
-- visitors): the Bishop's charts. Admin and Bishop only; anyone else gets no rows. No names or phone numbers.
drop function if exists church_trend();
create or replace function church_trend(upto date default null) returns table (
  church text, service_date date, name text, adults int, kids int, first_timers int, visitors int
) language sql stable security definer set search_path = public as $$
  with people as (
    select m.id, coalesce(nullif(trim(m.church), ''), app_home_church()) as ch, m.type,
           lower(coalesce(m.age_group, '')) in ('child', 'kid', 'kids', 'children') as kid
    from members m
    where lower(coalesce(m.status, '')) not in ('inactive', 'moved', 'left', 'deceased', 'transferred', 'away')),
  counts as (
    select p.ch, a.service_date as d, count(*) filter (where not p.kid)::int as ad, count(*) filter (where p.kid)::int as ki,
           count(*) filter (where p.type = 'first_timer')::int as ft, count(*) filter (where p.type = 'visitor')::int as vi
    from attendance a join people p on p.id = a.member_id
    where app_role() in ('admin', 'bishop') and a.service_date <= coalesce(upto, current_date + 1)
    group by 1, 2),
  ranked as (select c.*, row_number() over (partition by c.ch order by c.d desc) as rn from counts c)
  select r.ch, r.d, s.name, r.ad, r.ki, r.ft, r.vi
  from ranked r left join services s on s.service_date = r.d
  where r.rn <= 12 order by r.ch, r.d
$$;
-- Every day each church had a service, with how many came: the calendar on the Bishop's page. Counts only.
create or replace function church_days() returns table (church text, service_date date, present int)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(m.church), ''), app_home_church()), a.service_date, count(*)::int
  from attendance a join members m on m.id = a.member_id
  where app_role() in ('admin', 'bishop')
    and lower(coalesce(m.status, '')) not in ('inactive', 'moved', 'left', 'deceased', 'transferred', 'away')
  group by 1, 2 order by 2
$$;
revoke all on function church_days() from public, anon;
grant execute on function church_days() to authenticated;
revoke all on function church_trend(date) from public, anon;
grant execute on function church_trend(date) to authenticated;

revoke all on function church_numbers(date) from public, anon;
grant execute on function church_numbers(date), app_me(), app_role(), app_church(), app_can_see(text), app_home_church() to authenticated;

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
          case u.role when 'admin' then 'Admin' when 'lead' then case when u.title = 'Lead pastor' then 'Lead pastor' else 'Church admin' end when 'bishop' then 'Bishop' when 'pastor' then 'Pastor' else 'Team' end || ')', 80)
   from app_users u where u.email = lower(auth.jwt() ->> 'email') $$;

drop policy if exists "app: see sign-ups" on registrations;
create policy "app: see sign-ups" on registrations for select to authenticated using (app_can_approve());
grant select on registrations to authenticated;
-- The welcome form: a name and a phone number of 7 to 15 digits are required before a sign-up is accepted.
drop policy if exists "form can submit" on registrations;
create policy "form can submit" on registrations for insert to anon
  with check (status = 'pending' and length(trim(full_name)) between 2 and 120
              and length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) between 7 and 15);

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
-- Report lists: 'report_recipients' is the home church's, 'report_recipients:<church>' a branch's, and
-- 'report_recipients:*' the all-churches list. The admin manages all of them; a church admin only their own church's.
create or replace function app_report_church(k text) returns text language sql stable security definer set search_path = public as
$$ select case when k = 'report_recipients' then app_home_church()
               when k like 'report_recipients:%' and length(k) > 18 then substr(k, 19) end $$;
create or replace function app_report_ok(k text) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(app_report_church(k) is not null and (app_role() = 'admin'
     or (app_role() = 'lead' and app_report_church(k) = app_church())), false) $$;
revoke all on function app_report_church(text), app_report_ok(text) from public, anon;
grant execute on function app_report_church(text), app_report_ok(text) to authenticated;
drop policy if exists "app: admin sees report recipients" on settings;
drop policy if exists "app: admin adds report recipients" on settings;
drop policy if exists "app: admin changes report recipients" on settings;
drop policy if exists "app: see report lists" on settings;
create policy "app: see report lists" on settings for select to authenticated using (app_report_ok(key));
drop policy if exists "app: add report lists" on settings;
create policy "app: add report lists" on settings for insert to authenticated with check (app_report_ok(key));
drop policy if exists "app: change report lists" on settings;
create policy "app: change report lists" on settings for update to authenticated using (app_report_ok(key)) with check (app_report_ok(key));
-- Emails sent: the admin sees all; a church admin sees and records only their own church's
-- ('manual' and 'daily' belong to the home church, 'manual:<church>' to a branch).
create or replace function app_log_ok(k text) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(app_role() = 'admin' or (app_role() = 'lead' and
     case when k in ('manual', 'daily') then app_church() = app_home_church() else k = 'manual:' || app_church() end), false) $$;
revoke all on function app_log_ok(text) from public, anon;
grant execute on function app_log_ok(text) to authenticated;
drop policy if exists "app: admin reads the email log" on email_log;
drop policy if exists "app: read the email log" on email_log;
create policy "app: read the email log" on email_log for select to authenticated using (app_log_ok(kind));
drop policy if exists "app: record a sent email" on email_log;
create policy "app: record a sent email" on email_log for insert to authenticated with check (app_log_ok(kind));
grant select, insert on email_log to authenticated;
-- Help page: who to contact (settings key 'help_contact'). Everyone who can sign in reads it; the admin writes it.
drop policy if exists "app: see the help contact" on settings;
create policy "app: see the help contact" on settings for select to authenticated using (key = 'help_contact' and app_role() is not null);
drop policy if exists "app: admin adds the help contact" on settings;
create policy "app: admin adds the help contact" on settings for insert to authenticated with check (key = 'help_contact' and app_role() = 'admin');
drop policy if exists "app: admin changes the help contact" on settings;
create policy "app: admin changes the help contact" on settings for update to authenticated
  using (key = 'help_contact' and app_role() = 'admin') with check (key = 'help_contact' and app_role() = 'admin');
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
-- Save & lock on Check-in (settings key 'lock:<date>:<church>'): anyone who does check-in for that church can lock or unlock.
drop policy if exists "app: see check-in locks" on settings;
create policy "app: see check-in locks" on settings for select to authenticated
  using (key like 'lock:%' and app_role() in ('admin', 'lead', 'team') and app_can_see(substr(key, 17)));
drop policy if exists "app: set check-in locks" on settings;
create policy "app: set check-in locks" on settings for insert to authenticated
  with check (key like 'lock:%' and app_role() in ('admin', 'lead', 'team') and app_can_see(substr(key, 17)));
drop policy if exists "app: change check-in locks" on settings;
create policy "app: change check-in locks" on settings for update to authenticated
  using (key like 'lock:%' and app_role() in ('admin', 'lead', 'team') and app_can_see(substr(key, 17)))
  with check (key like 'lock:%' and app_role() in ('admin', 'lead', 'team') and app_can_see(substr(key, 17)));
grant select on email_log to authenticated;
-- Pastors use Save & lock like ushers: they see, set and lift locks for their own church's services.
drop policy if exists "app: pastors see check-in locks" on settings;
create policy "app: pastors see check-in locks" on settings for select to authenticated
  using (key like 'lock:%' and app_role() = 'pastor' and substr(key, 17) = app_church());
drop policy if exists "app: pastors set check-in locks" on settings;
create policy "app: pastors set check-in locks" on settings for insert to authenticated
  with check (key like 'lock:%' and app_role() = 'pastor' and substr(key, 17) = app_church());
drop policy if exists "app: pastors change check-in locks" on settings;
create policy "app: pastors change check-in locks" on settings for update to authenticated
  using (key like 'lock:%' and app_role() = 'pastor' and substr(key, 17) = app_church())
  with check (key like 'lock:%' and app_role() = 'pastor' and substr(key, 17) = app_church());

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

-- Database space for the Admin page: total size, and the biggest of the app's tables. Admin only.
create or replace function app_db_size() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if app_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  return json_build_object('total', pg_database_size(current_database()),
    'tables', (select json_agg(t order by t.bytes desc) from (
       select c.relname as name, pg_total_relation_size(c.oid) as bytes
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r') t));
end $$;
revoke all on function app_db_size() from public, anon;
grant execute on function app_db_size() to authenticated;

revoke all on function app_rename_church(text, text) from public, anon;
grant execute on function app_rename_church(text, text) to authenticated;

-- Livestream widget: a church's own YouTube channel, kept in churches.livestream as {"yt": channel id, "name": channel name}.
-- The app's server route (app/app-live) looks the channel up first, then saves it through this function.
-- The admin can set any church's; a church admin only their own church's. An empty link removes it.
create or replace function app_set_livestream(c text, link text) returns text
language plpgsql security definer set search_path = public as $$
declare ch text := trim(coalesce(c, '')); v text := nullif(trim(coalesce(link, '')), '');
begin
  if not (app_role() = 'admin' or (app_role() = 'lead' and app_church() = ch)) then raise exception 'not allowed'; end if;
  if not exists (select 1 from churches where name = ch) then raise exception 'there is no church called %', ch; end if;
  if length(v) > 500 then raise exception 'that link is too long'; end if;
  update churches set livestream = v where name = ch;
  return v;
end $$;
revoke all on function app_set_livestream(text, text) from public, anon;
grant execute on function app_set_livestream(text, text) to authenticated;

revoke all on function app_approve_signup(uuid, text, boolean, text), app_reject_signup(uuid, text), app_set_my_name(text) from public, anon;
grant execute on function app_pastor_name(), app_is_mine(text, text) to authenticated;
grant execute on function app_last_seen(), app_set_my_name(text), app_can_approve(), app_who(),
  app_approve_signup(uuid, text, boolean, text), app_reject_signup(uuid, text) to authenticated;

-- ---------------------------------------------------------------- Help → Contact the admin
-- Messages sent from the Help page. Anyone signed in can send one (through app_help_post, at most 5 an hour);
-- only the main admin can read, mark done or delete them.
create table if not exists help_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text, name text, role text, church text, topic text,
  message text not null check (length(message) between 1 and 2000),
  done boolean not null default false
);
alter table help_messages enable row level security;
drop policy if exists help_admin_read on help_messages;
create policy help_admin_read on help_messages for select to authenticated using (app_role() = 'admin');
drop policy if exists help_admin_update on help_messages;
create policy help_admin_update on help_messages for update to authenticated using (app_role() = 'admin') with check (app_role() = 'admin');
drop policy if exists help_admin_delete on help_messages;
create policy help_admin_delete on help_messages for delete to authenticated using (app_role() = 'admin');
grant select, update (done), delete on help_messages to authenticated;

-- Saves the message with the sender's own details, and returns the main admins' emails so the server can email them.
create or replace function app_help_post(topic text, message text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  me text := lower(auth.jwt() ->> 'email'); u app_users; new_id uuid;
begin
  select * into u from app_users where email = me;
  if u.email is null then raise exception 'not allowed'; end if;
  message := trim(coalesce(message, ''));
  if message = '' then raise exception 'Please type your message.'; end if;
  if length(message) > 2000 then raise exception 'Please keep the message under 2000 characters.'; end if;
  if (select count(*) from help_messages h where h.email = me and h.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You have sent 5 messages in the last hour. Please try again later.';
  end if;
  insert into help_messages (email, name, role, church, topic, message)
  values (me, u.name, u.role, coalesce(u.church, case when u.role in ('admin', 'bishop') then 'All churches' end),
          left(trim(coalesce(topic, '')), 80), message)
  returning id into new_id;
  return json_build_object('id', new_id, 'name', coalesce(nullif(trim(u.name), ''), me), 'email', me, 'role', u.role, 'church', u.church,
    'to', (select coalesce(json_agg(email), '[]'::json) from app_users where role = 'admin'));
end $$;
revoke all on function app_help_post(text, text) from public, anon;
grant execute on function app_help_post(text, text) to authenticated;

-- ---------------------------------------------------------------- Dashboard widgets: each person's own layout
-- Which widgets someone has on their Dashboard, in order. Everyone can only see and change their own row.
create table if not exists app_prefs (
  email text primary key,
  dash text[],
  updated_at timestamptz not null default now()
);
alter table app_prefs enable row level security;
drop policy if exists app_prefs_own on app_prefs;
create policy app_prefs_own on app_prefs for all to authenticated
  using (email = lower(auth.jwt() ->> 'email')) with check (email = lower(auth.jwt() ->> 'email'));
grant select, insert, update on app_prefs to authenticated;

-- ---------------------------------------------------------------- first church and first admin
insert into churches (name) values (app_home_church()) on conflict do nothing;
-- Then add yourself as the first admin (use your own email, lower case):
--   insert into app_users (email, role, name) values ('you@example.com', 'admin', 'Your Name') on conflict (email) do update set role = 'admin';

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- Ask: ready-made questions (Help → Ask a question)
-- Fifty fixed questions about attendance and the congregation. The app sends a question id (and a date, month, name or
-- number when the question needs one); the database runs the saved query and sends back a small table.
-- Nothing here writes data, and nobody can send their own SQL. These functions run with the signed-in person's own
-- rules (Row Level Security), so an usher or church admin only gets their church, a pastor only their own people,
-- and the Bishop (who has no access to names) is refused. Phone numbers are never returned. Safe to run again.

create or replace function app_ask_people(ch text default null) returns table (
  id text, full_name text, type text, kid boolean, gender text, pastor text, role text, status text, church text,
  active boolean, has_phone boolean, first_visit date, started date, added date
) language sql stable set search_path = public as $$
  select m.id, m.full_name,
         case when m.type in ('first_timer', 'visitor') then m.type else 'member' end,
         lower(coalesce(m.age_group, '')) in ('child', 'kid', 'kids', 'children'),
         case lower(trim(coalesce(m.gender, ''))) when 'f' then 'Female' when 'female' then 'Female'
              when 'm' then 'Male' when 'male' then 'Male' else 'Not given' end,
         nullif(trim(m.pastor), ''), nullif(trim(m.role), ''), coalesce(nullif(trim(m.status), ''), 'Active'),
         coalesce(nullif(trim(m.church), ''), app_home_church()),
         lower(coalesce(m.status, '')) not in ('inactive', 'moved', 'left', 'deceased', 'transferred', 'away'),
         nullif(regexp_replace(coalesce(m.phone, ''), '\s', '', 'g'), '') is not null,
         m.first_visit, least(m.date_joined, m.first_visit),
         case when left(m.created_at, 10) ~ '^\d{4}-\d{2}-\d{2}$' then left(m.created_at, 10)::date end
  from members m
  where ch is null or coalesce(nullif(trim(m.church), ''), app_home_church()) = ch
$$;

create or replace function app_ask_ticks(ch text default null) returns table (
  service_date date, id text, full_name text, type text, kid boolean, gender text, pastor text
) language sql stable set search_path = public as $$
  select a.service_date, p.id, p.full_name, p.type, p.kid, p.gender, p.pastor
  from attendance a join app_ask_people(ch) p on p.id = a.member_id
  where a.service_date <= current_date
$$;

-- One row per service that anyone in the church was ticked at, with the counts.
create or replace function app_ask_services(ch text default null) returns table (
  service_date date, name text, total int, adults int, kids int, first_timers int, visitors int, females int, males int
) language sql stable set search_path = public as $$
  select t.service_date,
         coalesce(nullif(trim(sv.name), ''), case extract(dow from t.service_date) when 0 then 'Sunday Service'
                  when 3 then 'Midweek Service' else 'Service' end),
         count(*)::int, (count(*) filter (where not t.kid))::int, (count(*) filter (where t.kid))::int,
         (count(*) filter (where t.type = 'first_timer'))::int, (count(*) filter (where t.type = 'visitor'))::int,
         (count(*) filter (where t.gender = 'Female'))::int, (count(*) filter (where t.gender = 'Male'))::int
  from app_ask_ticks(ch) t left join services sv on sv.service_date = t.service_date
  group by t.service_date, sv.name
$$;

-- Everyone with the last day they were ticked and how many Sunday services they have missed since (visitors: never).
-- Only Sunday services count as missed, and only ones on or after the day the person joined or first visited.
create or replace function app_ask_status(ch text default null) returns table (
  id text, full_name text, type text, pastor text, active boolean, started date, added date, last_seen date, missed int
) language sql stable set search_path = public as $$
  with p as (select * from app_ask_people(ch)),
  svc as (select distinct p.church as c, t.service_date from attendance t join p on p.id = t.member_id
          where t.service_date <= current_date and extract(dow from t.service_date) = 0),
  seen as (select a.member_id, max(a.service_date) as d from attendance a where a.service_date <= current_date group by 1)
  select p.id, p.full_name, p.type, p.pastor, p.active, p.started, p.added, s.d,
         case when p.type = 'visitor' then 0 else
           (select count(*) from svc v where v.c = p.church and v.service_date > coalesce(s.d, date '0001-01-01')
              and v.service_date >= coalesce(p.started, date '0001-01-01'))::int end
  from p left join seen s on s.member_id = p.id
$$;

create or replace function app_ask(q text, ch text default null, d date default null, m date default null,
                                   t text default null, n int default null) returns json
language plpgsql stable set search_path = public as $$
declare
  latest date; day date; mon date; nxt date; nn int; term text := lower(trim(coalesce(t, '')));
begin
  if app_role() is null or app_role() = 'bishop' then raise exception 'not allowed'; end if;
  select max(s.service_date) into latest from app_ask_services(ch) s;
  day := coalesce(d, latest);
  mon := date_trunc('month', coalesce(m, current_date))::date;
  nxt := (mon + interval '1 month')::date;
  if q in ('svc_name', 'p_role_who', 'p_search', 'a_person') and term = '' then raise exception 'Please type a name or word to look for.'; end if;
  if q in ('svc_day', 'svc_who_came', 'svc_who_missed', 'svc_first_timers', 'svc_gender') and day is null then raise exception 'There are no services yet.'; end if;

  -- ---------------------------------------------------------------- services
  if q in ('svc_latest', 'svc_day') then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.name as "Service", s.total as "Total", s.adults as "Adults",
             s.kids as "Kids", s.first_timers as "First-timers", s.visitors as "Visitors", s.females as "Females", s.males as "Males"
      from app_ask_services(ch) s where s.service_date = day) x);
  elsif q = 'svc_name' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.name as "Service", s.total as "Total", s.adults as "Adults",
             s.kids as "Kids", s.first_timers as "First-timers", s.females as "Females", s.males as "Males"
      from app_ask_services(ch) s where strpos(lower(s.name), term) > 0 order by s.service_date desc limit 60) x);
  elsif q = 'svc_who_came' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select k.full_name as "Name", case k.type when 'first_timer' then 'First-timer' when 'visitor' then 'Visitor' else 'Member' end as "Type",
             case when k.kid then 'Child' else 'Adult' end as "Age", k.gender as "Gender"
      from app_ask_ticks(ch) k where k.service_date = day order by k.full_name limit 400) x);
  elsif q = 'svc_who_missed' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", coalesce(p.pastor, 'Not assigned') as "Pastor",
             coalesce((select to_char(max(a.service_date), 'DD Mon YYYY') from attendance a where a.member_id = p.id and a.service_date < day), 'Never') as "Last seen before"
      from app_ask_people(ch) p
      where p.active and p.type <> 'visitor' and (p.started is null or p.started <= day)
        and not exists (select 1 from attendance a where a.member_id = p.id and a.service_date = day)
      order by p.full_name limit 400) x);
  elsif q = 'svc_first_timers' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select k.full_name as "Name", case when k.kid then 'Child' else 'Adult' end as "Age", k.gender as "Gender", coalesce(k.pastor, 'Not assigned') as "Pastor"
      from app_ask_ticks(ch) k where k.service_date = day and k.type = 'first_timer' order by k.full_name limit 400) x);
  elsif q = 'svc_gender' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select coalesce(k.gender, 'Everyone') as "Gender", (count(*) filter (where not k.kid))::int as "Adults",
             (count(*) filter (where k.kid))::int as "Kids", count(*)::int as "Total"
      from app_ask_ticks(ch) k where k.service_date = day group by rollup(k.gender)
      order by grouping(k.gender), k.gender) x);
  elsif q = 'svc_biggest' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.name as "Service", s.total as "Total", s.adults as "Adults",
             s.kids as "Kids", s.first_timers as "First-timers"
      from app_ask_services(ch) s order by s.total desc, s.service_date desc limit 10) x);
  elsif q = 'svc_smallest' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.name as "Service", s.total as "Total", s.adults as "Adults", s.kids as "Kids"
      from app_ask_services(ch) s where s.service_date >= current_date - 365 order by s.total asc, s.service_date desc limit 10) x);
  elsif q = 'svc_avg' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      with r as (select s.*, row_number() over (order by s.service_date desc) as rn from app_ask_services(ch) s where extract(dow from s.service_date) = 0)
      select 'Last 4 Sundays' as "Period", count(*)::int as "Sundays", round(avg(total))::int as "Average", max(total)::int as "Biggest" from r where rn <= 4
      union all select 'Last 12 Sundays', count(*)::int, round(avg(total))::int, max(total)::int from r where rn <= 12
      union all select 'This year', count(*)::int, round(avg(total))::int, max(total)::int from r where extract(year from service_date) = extract(year from current_date)
      union all select 'All time', count(*)::int, round(avg(total))::int, max(total)::int from r) x);
  elsif q = 'svc_last12' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.name as "Service", s.total as "Total", s.adults as "Adults", s.kids as "Kids", s.first_timers as "First-timers"
      from app_ask_services(ch) s where extract(dow from s.service_date) = 0 order by s.service_date desc limit 12) x);
  elsif q = 'svc_by_name' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select s.name as "Service", count(*)::int as "Times held", round(avg(s.total))::int as "Average", max(s.total)::int as "Biggest",
             to_char(max(s.service_date), 'DD Mon YYYY') as "Latest"
      from app_ask_services(ch) s group by s.name order by count(*) desc, s.name limit 60) x);
  elsif q = 'svc_month' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(g.mo, 'Mon YYYY') as "Month", count(*)::int as "Services", round(avg(g.total))::int as "Average", max(g.total)::int as "Biggest", sum(g.total)::int as "Total ticks"
      from (select date_trunc('month', s.service_date)::date as mo, s.total from app_ask_services(ch) s
            where s.service_date >= (date_trunc('month', current_date) - interval '11 months')::date) g
      group by g.mo order by g.mo desc) x);
  elsif q = 'svc_compare' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(g.mo, 'Mon YYYY') as "Month", count(*)::int as "Services", round(avg(g.total))::int as "Average", max(g.total)::int as "Biggest",
             sum(g.first_timers)::int as "First-timers ticked", sum(g.kids)::int as "Kids ticked"
      from (select date_trunc('month', s.service_date)::date as mo, s.* from app_ask_services(ch) s) g
      where g.mo in (mon, (mon - interval '1 month')::date) group by g.mo order by g.mo desc) x);
  elsif q = 'svc_special' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.name as "Service", s.total as "Total", s.kids as "Kids", s.first_timers as "First-timers"
      from app_ask_services(ch) s where lower(s.name) not in ('sunday service', 'midweek service', 'service')
      order by s.service_date desc limit 100) x);

  -- ---------------------------------------------------------------- first-timers (anyone with a first-visit date)
  elsif q = 'ft_month_count' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(mon, 'Mon YYYY') as "Month", count(*)::int as "First-timers",
             (count(*) filter (where exists (select 1 from attendance a where a.member_id = p.id and a.service_date > p.first_visit)))::int as "Came again",
             (count(*) filter (where not exists (select 1 from attendance a where a.member_id = p.id and a.service_date > p.first_visit)))::int as "Not back yet"
      from app_ask_people(ch) p where p.first_visit >= mon and p.first_visit < nxt) x);
  elsif q = 'ft_month_names' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", to_char(p.first_visit, 'DD Mon YYYY') as "First visit",
             case p.type when 'first_timer' then 'First-timer' when 'visitor' then 'Visitor' else 'Member now' end as "Now",
             (select count(*) from attendance a where a.member_id = p.id)::int as "Times came", coalesce(p.pastor, 'Not assigned') as "Pastor"
      from app_ask_people(ch) p where p.first_visit >= mon and p.first_visit < nxt order by p.first_visit, p.full_name limit 300) x);
  elsif q = 'ft_by_month' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(g.mo, 'Mon YYYY') as "Month", count(p.id)::int as "First-timers",
             (count(p.id) filter (where exists (select 1 from attendance a where a.member_id = p.id and a.service_date > p.first_visit)))::int as "Came again",
             case when count(p.id) = 0 then '-' else round(100.0 * (count(p.id) filter (where exists (select 1 from attendance a where a.member_id = p.id and a.service_date > p.first_visit))) / count(p.id))::int || '%' end as "Came back"
      from generate_series((date_trunc('month', current_date) - interval '11 months')::date, date_trunc('month', current_date)::date, interval '1 month') g(mo)
      left join app_ask_people(ch) p on p.first_visit >= g.mo and p.first_visit < (g.mo + interval '1 month')
      group by g.mo order by g.mo desc) x);
  elsif q = 'ft_came_back' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", to_char(p.first_visit, 'DD Mon YYYY') as "First visit",
             (select count(*) from attendance a where a.member_id = p.id and a.service_date > p.first_visit)::int as "Times since",
             to_char((select max(a.service_date) from attendance a where a.member_id = p.id), 'DD Mon YYYY') as "Last seen"
      from app_ask_people(ch) p
      where p.first_visit >= current_date - 365 and exists (select 1 from attendance a where a.member_id = p.id and a.service_date > p.first_visit)
      order by p.first_visit desc, p.full_name limit 200) x);
  elsif q = 'ft_not_back' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", to_char(p.first_visit, 'DD Mon YYYY') as "First visit", coalesce(p.pastor, 'Not assigned') as "Pastor"
      from app_ask_people(ch) p
      where p.active and p.first_visit >= current_date - 183 and p.first_visit <= current_date - 6
        and not exists (select 1 from attendance a where a.member_id = p.id and a.service_date > p.first_visit)
      order by p.first_visit desc, p.full_name limit 200) x);
  elsif q = 'ft_recent' then
    nn := coalesce(n, 30);
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", to_char(p.first_visit, 'DD Mon YYYY') as "First visit", case when p.kid then 'Child' else 'Adult' end as "Age",
             coalesce(p.pastor, 'Not assigned') as "Pastor"
      from app_ask_people(ch) p where p.first_visit >= current_date - nn and p.first_visit <= current_date
      order by p.first_visit desc, p.full_name limit 300) x);
  elsif q = 'new_people' then
    nn := coalesce(n, 30);
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", case p.type when 'first_timer' then 'First-timer' when 'visitor' then 'Visitor' else 'Member' end as "Type",
             to_char(p.added, 'DD Mon YYYY') as "Added", case when p.kid then 'Child' else 'Adult' end as "Age"
      from app_ask_people(ch) p where p.added >= current_date - nn order by p.added desc, p.full_name limit 300) x);

  -- ---------------------------------------------------------------- people (everyone who is still part of the church)
  elsif q = 'p_total' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select case when grouping(p.type) = 1 then 'Everyone' else case p.type when 'first_timer' then 'First-timers' when 'visitor' then 'Visitors' else 'Members' end end as "Who",
             (count(*) filter (where p.active))::int as "In the church now", (count(*) filter (where not p.active))::int as "Away or moved"
      from app_ask_people(ch) p group by rollup(p.type)
      order by grouping(p.type), case p.type when 'member' then 0 when 'first_timer' then 1 else 2 end) x);
  elsif q in ('p_females', 'p_males') then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select case when q = 'p_females' then 'Females' else 'Males' end as "Who", count(*)::int as "Total",
             (count(*) filter (where not p.kid))::int as "Adults", (count(*) filter (where p.kid))::int as "Kids"
      from app_ask_people(ch) p where p.active and p.gender = case when q = 'p_females' then 'Female' else 'Male' end) x);
  elsif q in ('p_kids', 'p_adults') then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select coalesce(p.gender, 'Everyone') as "Gender", count(*)::int as "Total"
      from app_ask_people(ch) p where p.active and p.kid = (q = 'p_kids') group by rollup(p.gender)
      order by grouping(p.gender), p.gender) x);
  elsif q = 'p_gender_age' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select coalesce(p.gender, 'Everyone') as "Gender", (count(*) filter (where not p.kid))::int as "Adults",
             (count(*) filter (where p.kid))::int as "Kids", count(*)::int as "Total"
      from app_ask_people(ch) p where p.active group by rollup(p.gender) order by grouping(p.gender), p.gender) x);
  elsif q = 'p_gender_missing' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", case when p.kid then 'Child' else 'Adult' end as "Age",
             case p.type when 'first_timer' then 'First-timer' when 'visitor' then 'Visitor' else 'Member' end as "Type"
      from app_ask_people(ch) p where p.active and p.gender = 'Not given' order by p.full_name limit 400) x);
  elsif q = 'p_by_church' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.church as "Church", count(*)::int as "People", (count(*) filter (where not p.kid))::int as "Adults", (count(*) filter (where p.kid))::int as "Kids",
             (count(*) filter (where p.gender = 'Female'))::int as "Females", (count(*) filter (where p.gender = 'Male'))::int as "Males"
      from app_ask_people(null) p where p.active group by p.church order by (p.church <> app_home_church()), p.church) x);
  elsif q = 'p_by_pastor' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select coalesce(trim(u.pn), 'Not assigned') as "Pastor", count(*)::int as "People", (count(*) filter (where p.kid))::int as "Kids"
      from app_ask_people(ch) p left join lateral unnest(string_to_array(p.pastor, ',')) as u(pn) on true
      where p.active and p.type <> 'visitor' group by 1 order by (coalesce(trim(u.pn), 'Not assigned') = 'Not assigned'), 2 desc, 1) x);
  elsif q = 'p_no_pastor' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", case when p.kid then 'Child' else 'Adult' end as "Age",
             case p.type when 'first_timer' then 'First-timer' else 'Member' end as "Type"
      from app_ask_people(ch) p where p.active and p.type <> 'visitor' and p.pastor is null order by p.full_name limit 400) x);
  elsif q = 'p_no_phone' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", case when p.kid then 'Child' else 'Adult' end as "Age", coalesce(p.pastor, 'Not assigned') as "Pastor"
      from app_ask_people(ch) p where p.active and not p.has_phone order by p.full_name limit 400) x);
  elsif q = 'p_by_role' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select trim(u.r) as "Team or role", count(*)::int as "People"
      from app_ask_people(ch) p cross join lateral unnest(string_to_array(p.role, ',')) as u(r)
      where p.active and trim(u.r) <> '' group by 1 order by 2 desc, 1) x);
  elsif q = 'p_role_who' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", p.role as "Team or role", coalesce(p.pastor, 'Not assigned') as "Pastor"
      from app_ask_people(ch) p where p.active and strpos(lower(coalesce(p.role, '')), term) > 0 order by p.full_name limit 300) x);
  elsif q = 'p_status' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.status as "Status", count(*)::int as "People" from app_ask_people(ch) p group by p.status order by 2 desc, 1) x);
  elsif q = 'p_archive' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select s.full_name as "Name", coalesce(to_char(s.last_seen, 'DD Mon YYYY'), 'Never ticked') as "Last seen", coalesce(s.pastor, 'Not assigned') as "Pastor"
      from app_ask_status(ch) s
      where s.active and coalesce(s.last_seen, s.started, s.added) < current_date - 730
      order by coalesce(s.last_seen, s.started, s.added), s.full_name limit 300) x);
  elsif q = 'p_search' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select p.full_name as "Name", case p.type when 'first_timer' then 'First-timer' when 'visitor' then 'Visitor' else 'Member' end as "Type",
             case when p.kid then 'Child' else 'Adult' end as "Age", p.gender as "Gender", coalesce(p.pastor, 'Not assigned') as "Pastor",
             p.status as "Status", coalesce(to_char(s.last_seen, 'DD Mon YYYY'), 'Never') as "Last seen",
             (select count(*) from attendance a where a.member_id = p.id and a.service_date <= current_date)::int as "Times came"
      from app_ask_people(ch) p join app_ask_status(ch) s on s.id = p.id
      where strpos(lower(p.full_name), term) > 0 order by p.full_name limit 30) x);
  elsif q = 'p_visitors' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select s.full_name as "Name", coalesce(to_char(s.last_seen, 'DD Mon YYYY'), 'Never') as "Last seen",
             (select count(*) from attendance a where a.member_id = s.id and a.service_date <= current_date)::int as "Times came"
      from app_ask_status(ch) s where s.type = 'visitor' and s.active order by s.last_seen desc nulls last, s.full_name limit 300) x);

  -- ---------------------------------------------------------------- attendance and follow-up
  elsif q in ('a_red', 'a_yellow', 'a_blue', 'a_missed_n') then
    nn := coalesce(n, 3);
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select s.full_name as "Name", s.missed as "Sundays missed", coalesce(to_char(s.last_seen, 'DD Mon YYYY'), 'Never') as "Last seen", coalesce(s.pastor, 'Not assigned') as "Pastor"
      from app_ask_status(ch) s
      where s.active and s.type <> 'visitor' and coalesce(s.last_seen, s.started, s.added, current_date) >= current_date - 730
        and case q when 'a_red' then s.missed >= 5 when 'a_yellow' then s.missed between 3 and 4
                   when 'a_blue' then s.missed between 1 and 2 else s.missed >= nn end
      order by s.missed desc, s.full_name limit 300) x);
  elsif q = 'a_away_weeks' then
    nn := coalesce(n, 4);
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select s.full_name as "Name", to_char(s.last_seen, 'DD Mon YYYY') as "Last seen", ((current_date - s.last_seen) / 7)::int as "Weeks ago", coalesce(s.pastor, 'Not assigned') as "Pastor"
      from app_ask_status(ch) s
      where s.active and s.type <> 'visitor' and s.last_seen is not null and s.last_seen < current_date - 7 * nn and s.last_seen >= current_date - 730
      order by s.last_seen desc, s.full_name limit 300) x);
  elsif q = 'a_faithful' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      with r as (select s.service_date from app_ask_services(ch) s where extract(dow from s.service_date) = 0 order by s.service_date desc limit 12)
      select k.full_name as "Name", count(*)::int as "Sundays came", (select count(*) from r)::int as "Out of"
      from app_ask_ticks(ch) k join r on r.service_date = k.service_date
      group by k.id, k.full_name order by count(*) desc, k.full_name limit 15) x);
  elsif q = 'a_perfect' then
    nn := coalesce(n, 4);
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      with r as (select s.service_date from app_ask_services(ch) s where extract(dow from s.service_date) = 0 order by s.service_date desc limit nn)
      select k.full_name as "Name", coalesce(k.pastor, 'Not assigned') as "Pastor"
      from app_ask_ticks(ch) k join r on r.service_date = k.service_date
      group by k.id, k.full_name, k.pastor having count(*) = (select count(*) from r) and (select count(*) from r) > 0
      order by k.full_name limit 300) x);
  elsif q = 'a_person' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select k.full_name as "Name", to_char(k.service_date, 'DD Mon YYYY') as "Date", s.name as "Service"
      from app_ask_ticks(ch) k join app_ask_services(ch) s on s.service_date = k.service_date
      where strpos(lower(k.full_name), term) > 0 order by k.service_date desc, k.full_name limit 60) x);
  elsif q = 'a_gender_trend' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select to_char(s.service_date, 'DD Mon YYYY') as "Date", s.females as "Females", s.males as "Males", s.kids as "Kids", s.total as "Total"
      from app_ask_services(ch) s where extract(dow from s.service_date) = 0 order by s.service_date desc limit 8) x);
  elsif q = 'a_pastor_last' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select coalesce(trim(u.pn), 'Not assigned') as "Pastor", count(*)::int as "People",
             (count(*) filter (where exists (select 1 from attendance a where a.member_id = p.id and a.service_date = latest)))::int as "Came",
             (count(*) filter (where not exists (select 1 from attendance a where a.member_id = p.id and a.service_date = latest)))::int as "Missed"
      from app_ask_people(ch) p left join lateral unnest(string_to_array(p.pastor, ',')) as u(pn) on true
      where p.active and p.type <> 'visitor' and latest is not null group by 1 order by (coalesce(trim(u.pn), 'Not assigned') = 'Not assigned'), 1) x);
  elsif q = 'a_new_attenders' then
    return (select coalesce(json_agg(row_to_json(x)), '[]'::json) from (
      select f.full_name as "Name", to_char(f.first_day, 'DD Mon YYYY') as "First came",
             case f.type when 'first_timer' then 'First-timer' when 'visitor' then 'Visitor' else 'Member' end as "Type"
      from (select k.id, k.full_name, k.type, min(k.service_date) as first_day from app_ask_ticks(ch) k group by 1, 2, 3) f
      where f.first_day >= mon and f.first_day < nxt order by f.first_day, f.full_name limit 300) x);
  end if;
  raise exception 'That question is not on the list.';
end $$;

revoke all on function app_ask_people(text), app_ask_ticks(text), app_ask_services(text), app_ask_status(text),
  app_ask(text, text, date, date, text, int) from public, anon;
grant execute on function app_ask_people(text), app_ask_ticks(text), app_ask_services(text), app_ask_status(text),
  app_ask(text, text, date, date, text, int) to authenticated;

-- Live updates: Check-in hears straight away when another phone ticks or unticks someone (Supabase Realtime), instead of
-- asking every few seconds. Only people allowed to see the ticks get the notes: the same row rules apply. Safe to run again.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if to_regclass('public.attendance') is not null and not exists (select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance') then
      alter publication supabase_realtime add table public.attendance;
    end if;
    if to_regclass('public.service_ticks') is not null and not exists (select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_ticks') then
      alter publication supabase_realtime add table public.service_ticks;
    end if;
  end if;
end $$;
