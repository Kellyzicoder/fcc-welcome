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

-- Titles saved one way, in full words: "Rev. Ama Mensah" → "Reverend Ama Mensah", "Pst."/"Ps." → "Pastor",
-- "LP"/"Lady Pst." → "Lady Pastor", "Bp." → "Bishop". The app shows them short (Rev., Pst., LP); reports get the full words.
create or replace function app_full_title(n text) returns text language sql immutable set search_path = public as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           trim(regexp_replace(coalesce(n, ''), '\s+', ' ', 'g')),
           '^(lady\s+(pastor|pst\.?|ps\.?)|lp\.?)\s+', 'Lady Pastor ', 'i'),
           '^(reverend|revd\.?|rev\.?)\s+', 'Reverend ', 'i'),
           '^(pastor|pst\.?|ps\.?)\s+', 'Pastor ', 'i'),
           '^(bishop|bp\.?)\s+', 'Bishop ', 'i')
$$;

alter table members add column if not exists church text;
alter table members add column if not exists age_group text;
alter table members add column if not exists pastor text;
alter table members add column if not exists shepherd text;  -- a person's shepherds (comma-separated), kept apart from pastors
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

-- The same, for the rules: a Shepherd sign-in looks after the people whose Shepherd field has their name; a Pastor, the Pastor field.
create or replace function app_is_mine(ch text, pastors text, shepherds text) returns boolean language sql stable security definer set search_path = public as
$$ select case when (select title from app_users where email = lower(auth.jwt() ->> 'email')) = 'Shepherd'
     then app_is_mine(ch, shepherds) else app_is_mine(ch, pastors) end $$;

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
create policy "app: pastors see their own people" on members for select to authenticated using (app_is_mine(church, pastor, shepherd));
drop policy if exists "app: pastors see their people's ticks" on attendance;
create policy "app: pastors see their people's ticks" on attendance for select to authenticated
  using (exists (select 1 from members m where m.id = member_id and app_is_mine(m.church, m.pastor, m.shepherd)));
drop policy if exists "app: pastors tick their people" on attendance;
create policy "app: pastors tick their people" on attendance for insert to authenticated
  with check (exists (select 1 from members m where m.id = member_id and app_is_mine(m.church, m.pastor, m.shepherd)));
drop policy if exists "app: pastors untick their people" on attendance;
create policy "app: pastors untick their people" on attendance for delete to authenticated
  using (exists (select 1 from members m where m.id = member_id and app_is_mine(m.church, m.pastor, m.shepherd)));

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
  using (exists (select 1 from members m where m.id = member_id and (app_can_see(m.church) or app_is_mine(m.church, m.pastor, m.shepherd))));
drop policy if exists "app: tick own church's people at a service" on service_ticks;
create policy "app: tick own church's people at a service" on service_ticks for insert to authenticated
  with check (exists (select 1 from members m where m.id = member_id and (app_can_see(m.church) or app_is_mine(m.church, m.pastor, m.shepherd))));
drop policy if exists "app: untick own church's people at a service" on service_ticks;
create policy "app: untick own church's people at a service" on service_ticks for delete to authenticated
  using (exists (select 1 from members m where m.id = member_id and (app_can_see(m.church) or app_is_mine(m.church, m.pastor, m.shepherd))));
grant select, insert, update, delete on service_parts to authenticated;
grant select, insert, delete on service_ticks to authenticated;

-- All or nothing: changes that take several steps run as one database call, so they're saved together or not at all
-- (a dropped signal halfway can't leave half a change). They run with the person's own rights, so the rules above still
-- decide what each person may change. Two phones doing the same at once take turns (the lock on that church's day).
create or replace function app_day_parts(ch text, d date) returns json language sql stable set search_path = public as
$$ select coalesce(json_agg(json_build_object('part', part, 'name', name) order by part), '[]'::json)
   from service_parts where church = ch and service_date = d $$;

-- Check-in → Add a service: the day's title, the services, and (the first time) everyone ticked so far goes in the first one
create or replace function app_add_service(ch text, d date, title text, first_name text) returns json
language plpgsql set search_path = public as $$
declare n int; nxt int;
begin
  if coalesce(app_role(), '') not in ('admin', 'lead', 'team') or not app_can_see(ch) then raise exception 'not allowed'; end if;
  perform pg_advisory_xact_lock(hashtext('parts:' || ch || ':' || d));
  select count(*), coalesce(max(part), 0) into n, nxt from service_parts where church = ch and service_date = d;
  if n >= 3 then raise exception 'Three services is the most for one day.'; end if;
  insert into services (service_date, name) values (d, left(coalesce(nullif(trim(title), ''), 'Service'), 60)) on conflict (service_date) do nothing;
  if n < 2 then
    insert into service_parts (church, service_date, part, name) values
      (ch, d, 1, left(coalesce(nullif(trim(first_name), ''), 'First service'), 60)), (ch, d, 2, 'Second service')
      on conflict (church, service_date, part) do update set name = excluded.name;
    insert into service_ticks (service_date, part, member_id, checked_at)  -- everyone this church ticked so far today
      select a.service_date, 1, a.member_id, a.checked_at from attendance a join members m on m.id = a.member_id
      where a.service_date = d and coalesce(nullif(trim(m.church), ''), app_home_church()) = ch
      on conflict do nothing;
  else
    nxt := nxt + 1;
    insert into service_parts (church, service_date, part, name)
      values (ch, d, nxt, (array['First', 'Second', 'Third', 'Fourth', 'Fifth'])[nxt] || ' service');
  end if;
  return app_day_parts(ch, d);
end $$;

-- Check-in → Remove a service: the last one added and its ticks (back to one service when only one would be left)
create or replace function app_remove_service(ch text, d date) returns json
language plpgsql set search_path = public as $$
declare parts int[]; gone int[];
begin
  if coalesce(app_role(), '') not in ('admin', 'lead', 'team') or not app_can_see(ch) then raise exception 'not allowed'; end if;
  perform pg_advisory_xact_lock(hashtext('parts:' || ch || ':' || d));
  select coalesce(array_agg(part order by part), '{}') into parts from service_parts where church = ch and service_date = d;
  if cardinality(parts) = 0 then return '[]'::json; end if;
  gone := case when cardinality(parts) <= 2 then parts else array[parts[cardinality(parts)]] end;
  delete from service_ticks t using members m
    where m.id = t.member_id and coalesce(nullif(trim(m.church), ''), app_home_church()) = ch and t.service_date = d and t.part = any(gone);
  delete from service_parts where church = ch and service_date = d and part = any(gone);
  return app_day_parts(ch, d);
end $$;

-- Check-in → renaming one of the day's services; the first one's name is the day's title too
create or replace function app_rename_service(ch text, d date, p int, new_name text) returns text
language plpgsql set search_path = public as $$
declare v text := left(trim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 60);
begin
  if coalesce(app_role(), '') not in ('admin', 'lead', 'team') or not app_can_see(ch) then raise exception 'not allowed'; end if;
  if v = '' then raise exception 'type the service''s name'; end if;
  update service_parts set name = v where church = ch and service_date = d and part = p;
  if not found then raise exception 'that service is not there any more'; end if;
  if p = (select min(part) from service_parts where church = ch and service_date = d) then
    insert into services (service_date, name) values (d, v) on conflict (service_date) do update set name = excluded.name;
  end if;
  return v;
end $$;

-- Check-in → Untick all / Clear: these people off the day (and its services), or off one service (and off the day too
-- when they're at none of its services any more). Returns how many came off.
create or replace function app_clear_service(d date, ids text[], p int default null) returns int
language plpgsql set search_path = public as $$
declare n int;
begin
  if coalesce(app_role(), '') not in ('admin', 'lead', 'team', 'pastor') then raise exception 'not allowed'; end if;
  if p is null then
    delete from attendance where service_date = d and member_id = any(ids);
    get diagnostics n = row_count;
    delete from service_ticks where service_date = d and member_id = any(ids);
  else
    delete from service_ticks where service_date = d and part = p and member_id = any(ids);
    get diagnostics n = row_count;
    delete from attendance a where a.service_date = d and a.member_id = any(ids)
      and not exists (select 1 from service_ticks t where t.service_date = d and t.member_id = a.member_id);
  end if;
  return n;
end $$;

-- The Activity log keeps 12 months: each time something is added, entries older than that are removed (the index on "at"
-- makes this quick, and almost always there is nothing to remove). Nothing else is ever deleted from the log.
create or replace function app_trim_activity() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from activity_log where at < to_char(now() - interval '12 months', 'YYYY-MM-DD');
  return null;
end $$;
revoke all on function app_trim_activity() from public, anon, authenticated;
drop trigger if exists app_trim_activity on activity_log;
create trigger app_trim_activity after insert on activity_log for each statement execute function app_trim_activity();

revoke all on function app_day_parts(text, date), app_add_service(text, date, text, text), app_remove_service(text, date),
  app_rename_service(text, date, int, text), app_clear_service(date, text[], int) from public, anon;
grant execute on function app_day_parts(text, date), app_add_service(text, date, text, text), app_remove_service(text, date),
  app_rename_service(text, date, int, text), app_clear_service(date, text[], int) to authenticated;

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
          case u.role when 'admin' then case when u.title = 'Tech admin' then 'Tech admin' else 'Admin' end when 'lead' then case when u.title = 'Lead pastor' then 'Lead pastor' else 'Church admin' end when 'bishop' then 'Bishop' when 'pastor' then case u.title when 'Shepherd' then 'Shepherd' when 'Reverend' then 'Reverend' else 'Pastor' end else 'Team' end || ')', 80)
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
-- Each church's list of shepherds (settings key 'shepherds:<church>'): the same rules as the pastor list.
drop policy if exists "app: see own church's shepherd list" on settings;
create policy "app: see own church's shepherd list" on settings for select to authenticated
  using (key like 'shepherds:%' and app_can_see(substr(key, 11)));
drop policy if exists "app: leads add their shepherd list" on settings;
create policy "app: leads add their shepherd list" on settings for insert to authenticated
  with check (key like 'shepherds:%' and app_role() in ('admin', 'lead') and app_can_see(substr(key, 11)));
drop policy if exists "app: leads change their shepherd list" on settings;
create policy "app: leads change their shepherd list" on settings for update to authenticated
  using (key like 'shepherds:%' and app_role() in ('admin', 'lead') and app_can_see(substr(key, 11)))
  with check (key like 'shepherds:%' and app_role() in ('admin', 'lead') and app_can_see(substr(key, 11)));
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

-- Check-in: someone with a status (Away, Inactive, Moved, Left…) who is ticked in is Active again. Anyone who may tick them can do it (ushers and
-- pastors too); never a status set to "Off for good" (Deceased unless changed), and nothing else about the person.
create or replace function app_back_active(mid text) returns boolean language plpgsql security definer set search_path = public as $$
declare n int; who text;
begin
  if app_role() is null or app_role() not in ('admin', 'lead', 'team', 'pastor') then return false; end if;
  update members m set status = '', version = m.version + 1
   where m.id = mid and trim(coalesce(m.status, '')) <> ''
     and coalesce((select r.value from settings s, json_each_text(s.value::json) r  -- the church's own rule for this status (Settings → Statuses)
                   where s.key = 'status_rules:' || coalesce(nullif(trim(m.church), ''), app_home_church()) and lower(r.key) = lower(trim(m.status)) limit 1),
                  case when lower(trim(m.status)) = 'deceased' then 'gone' else 'in' end) <> 'gone'
     and (app_can_see(m.church) or app_is_mine(m.church, m.pastor, m.shepherd))
  returning m.full_name into who;
  get diagnostics n = row_count;
  if n > 0 then
    insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
    values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'edit', null, mid,
            'back: set to Active when ticked in', app_who(), 'done');
  end if;
  return n > 0;
end $$;
revoke all on function app_back_active(text) from public, anon;
grant execute on function app_back_active(text) to authenticated;

-- Statuses (Settings → Statuses): what each status does at each church, kept as {"Away": "in", "Left": "out", "Deceased": "gone", ...}.
-- Anyone who ticks people in can change their own church's (an admin any church's).
create or replace function app_status_rules() returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(substr(key, 14), value::json), '{}'::json) from settings where key like 'status_rules:%' and app_role() is not null
$$;
revoke all on function app_status_rules() from public, anon;
grant execute on function app_status_rules() to authenticated;
create or replace function app_set_status_rules(ch text, rules json) returns boolean language plpgsql security definer set search_path = public as $$
declare c text := coalesce(nullif(trim(ch), ''), app_home_church()); k text; v text; n int := 0;
begin
  if app_role() is null or app_role() not in ('admin', 'lead', 'team', 'pastor') then raise exception 'not allowed'; end if;
  if app_role() <> 'admin' and c <> coalesce(nullif(trim(app_church()), ''), app_home_church()) then raise exception 'not allowed'; end if;
  if json_typeof(rules) <> 'object' then raise exception 'not a list of statuses'; end if;
  for k, v in select key, value from json_each_text(rules) loop
    n := n + 1;
    if n > 40 or length(trim(k)) not between 1 and 40 or v not in ('in', 'out', 'gone') then raise exception 'not a valid status: %', k; end if;
  end loop;
  insert into settings (key, value) values ('status_rules:' || c, rules::text) on conflict (key) do update set value = excluded.value;
  insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
  values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'edit', null, null, 'statuses changed · ' || c, app_who(), 'done');
  return true;
end $$;
revoke all on function app_set_status_rules(text, json) from public, anon;
grant execute on function app_set_status_rules(text, json) to authenticated;

-- ---------------------------------------------------------------- Backups: a Google Sheet that copies everything each night
-- ---------------------------------------------------------------- Bacentas (cell groups)
-- A Bacenta is a small group that meets during the week. Each one belongs to a church (its area, e.g. Auckland), has a
-- name its shepherd picks, and the shepherd's name from the church's Shepherds list. A Bacenta that stops meeting is
-- hidden, not deleted, so its past attendance stays.
-- Bacenta check-ins are kept apart from service attendance: they never change a service's numbers, the Sunday
-- follow-up flags, reports or the Streamlit tracker.
create table if not exists bacentas (
  id uuid primary key default gen_random_uuid(),
  church text not null references churches(name) on update cascade on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  shepherd text check (length(shepherd) <= 80),
  active boolean not null default true,
  created_at timestamptz not null default now());
create unique index if not exists bacentas_church_name on bacentas (church, lower(trim(name)));
create table if not exists bacenta_ticks (
  bacenta uuid not null references bacentas(id) on delete cascade,
  meeting_date date not null,
  member_id text not null references members(id) on delete cascade,
  checked_at text,
  primary key (bacenta, meeting_date, member_id));
create index if not exists bacenta_ticks_member on bacenta_ticks (member_id);
alter table bacentas enable row level security;
alter table bacenta_ticks enable row level security;

-- may the signed-in person take attendance for this Bacenta? Admins, church admins and the team for their church;
-- a shepherd for the Bacenta that has their name on it
create or replace function app_bacenta_ok(b uuid) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select app_can_see(x.church)
     or (app_role() = 'pastor' and x.church = app_church() and lower(regexp_replace(trim(x.shepherd), '\s+', ' ', 'g')) = app_pastor_name())
     from bacentas x where x.id = b), false) $$;
-- …and may they tick this person there? Someone of the Bacenta's own church (checked here, not through the people
-- rules, because a shepherd ticks people who aren't assigned to them too)
create or replace function app_bacenta_tick_ok(b uuid, mid text) returns boolean language sql stable security definer set search_path = public as
$$ select app_bacenta_ok(b) and exists (select 1 from bacentas x join members m on m.id = mid
     where x.id = b and coalesce(nullif(trim(m.church), ''), app_home_church()) = x.church) $$;
revoke all on function app_bacenta_ok(uuid), app_bacenta_tick_ok(uuid, text) from public, anon;
grant execute on function app_bacenta_ok(uuid), app_bacenta_tick_ok(uuid, text) to authenticated;

drop policy if exists "app: see bacentas" on bacentas;
create policy "app: see bacentas" on bacentas for select to authenticated
  using (app_can_see(church) or (app_role() = 'pastor' and church = app_church()));
drop policy if exists "app: add bacentas" on bacentas;
create policy "app: add bacentas" on bacentas for insert to authenticated
  with check (app_role() in ('admin', 'lead') and app_can_see(church));
drop policy if exists "app: change bacentas" on bacentas;
create policy "app: change bacentas" on bacentas for update to authenticated
  using (app_role() in ('admin', 'lead') and app_can_see(church))
  with check (app_role() in ('admin', 'lead') and app_can_see(church));
grant select, insert, update on bacentas to authenticated;

drop policy if exists "app: see bacenta ticks" on bacenta_ticks;
create policy "app: see bacenta ticks" on bacenta_ticks for select to authenticated using (app_bacenta_ok(bacenta));
drop policy if exists "app: tick at a bacenta" on bacenta_ticks;
create policy "app: tick at a bacenta" on bacenta_ticks for insert to authenticated
  with check (app_bacenta_tick_ok(bacenta, member_id));
drop policy if exists "app: untick at a bacenta" on bacenta_ticks;
create policy "app: untick at a bacenta" on bacenta_ticks for delete to authenticated using (app_bacenta_ok(bacenta));
grant select, insert, delete on bacenta_ticks to authenticated;

-- A shepherd ticks anyone of their church at their Bacenta (not only people assigned to them), so they need the names:
-- just the name and type, nothing else (no phone, no email), for the people of their own church.
create or replace function app_bacenta_people() returns table (id text, full_name text, type text, age_group text)
language sql stable security definer set search_path = public as $$
  select m.id, m.full_name, m.type, m.age_group from members m
  where app_role() = 'pastor' and exists (select 1 from bacentas b where b.church = app_church() and b.active
          and lower(regexp_replace(trim(b.shepherd), '\s+', ' ', 'g')) = app_pastor_name())
    and coalesce(nullif(trim(m.church), ''), app_home_church()) = app_church()
  order by m.full_name $$;
revoke all on function app_bacenta_people() from public, anon;
grant execute on function app_bacenta_people() to authenticated;

-- The first Bacenta: Saved - City Bacenta, in Auckland (only when the Auckland church is there; never added twice)
insert into bacentas (church, name)
  select 'Auckland', 'Saved - City Bacenta' where exists (select 1 from churches where name = 'Auckland')
  on conflict do nothing;

-- Admin → Backups makes a backup key (only its fingerprint is kept here) and the script for a Google Sheet; the sheet's
-- script sends the key each night and gets back every church, person, service and check-in, the Bacentas and their check-ins,
-- the pastor and shepherd lists
-- and the sign-ins. The key only reads; making a new one stops the old one working. Safe to run again.
create table if not exists backup_keys (
  id int primary key default 1 check (id = 1),
  hash bytea not null,
  made_at timestamptz not null default now(),
  made_by text,
  last_used timestamptz
);
alter table backup_keys enable row level security;  -- no policies: only the functions below can read it
revoke all on backup_keys from anon, authenticated;

create or replace function app_backup_data() returns json language sql stable security definer set search_path = public as $$
  select json_build_object('made_at', now(), 'home', app_home_church(),
    'churches', (select coalesce(json_agg(t order by t.name), '[]') from churches t),
    'members', (select coalesce(json_agg(t order by t.full_name), '[]') from members t),
    'attendance', (select coalesce(json_agg(t order by t.service_date, t.full_name), '[]') from (  -- each check-in with the person's name and church
      select a.*, m.full_name, coalesce(nullif(trim(m.church), ''), app_home_church()) as church
      from attendance a left join members m on m.id = a.member_id) t),
    'services', (select coalesce(json_agg(t order by t.service_date), '[]') from services t),
    'service_parts', (select coalesce(json_agg(t order by t.service_date), '[]') from service_parts t),
    'service_ticks', (select coalesce(json_agg(t order by t.service_date), '[]') from service_ticks t),
    'bacentas', (select coalesce(json_agg(t order by t.church, t.name), '[]') from bacentas t),
    'bacenta_ticks', (select coalesce(json_agg(t order by t.meeting_date, t.bacenta_name, t.full_name), '[]') from (  -- each Bacenta check-in with the Bacenta's and the person's names
      select k.*, b.name as bacenta_name, b.church, m.full_name
      from bacenta_ticks k join bacentas b on b.id = k.bacenta left join members m on m.id = k.member_id) t),
    'lists', (select coalesce(json_agg(json_build_object('key', t.key, 'names', t.value) order by t.key), '[]') from settings t
              where t.key like 'pastors:%' or t.key like 'shepherds:%'),
    'signins', (select coalesce(json_agg(json_build_object('email', u.email, 'role', u.role, 'title', u.title, 'role3', u.role3, 'church', u.church,
                  'name', u.name, 'pastor', u.pastor) order by u.email), '[]') from app_users u))
$$;
revoke all on function app_backup_data() from public, anon, authenticated;

-- a new key (admin): shown once, to go in the Google Sheet's script
create or replace function app_backup_key() returns text language plpgsql security definer set search_path = public as $$
declare k text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if app_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  insert into backup_keys (id, hash, made_by) values (1, sha256(convert_to(k, 'UTF8')), app_who())
  on conflict (id) do update set hash = excluded.hash, made_at = now(), made_by = excluded.made_by, last_used = null;
  return k;
end $$;
revoke all on function app_backup_key() from public, anon;
grant execute on function app_backup_key() to authenticated;

-- when the key was made and when the sheet last copied (admin)
create or replace function app_backup_status() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if app_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  return (select json_build_object('made_at', made_at, 'made_by', made_by, 'last_used', last_used) from backup_keys where id = 1);
end $$;
revoke all on function app_backup_status() from public, anon;
grant execute on function app_backup_status() to authenticated;

-- what the Google Sheet calls each night, with its key
create or replace function app_backup(backup_key text) returns json language plpgsql security definer set search_path = public as $$
begin
  if coalesce(backup_key, '') = '' or not exists (select 1 from backup_keys where hash = sha256(convert_to(backup_key, 'UTF8'))) then
    raise exception 'not allowed'; end if;
  update backup_keys set last_used = now() where id = 1;
  return app_backup_data();
end $$;
revoke all on function app_backup(text) from public;
grant execute on function app_backup(text) to anon, authenticated;

-- Pastors page → Tidy titles (admin): every pastor name written the same way, everywhere it is used at once
-- (each church's Pastors list, the pastor on each person, and pastor sign-ins), so nobody loses their people.
create or replace function app_tidy_titles() returns json language plpgsql security definer set search_path = public as $$
declare l int := 0; m int := 0; u int := 0;
begin
  if app_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  with t as (
    select s.key, (select string_agg(x.v, E'\n' order by x.i) from (
             select distinct on (lower(app_full_title(e))) app_full_title(e) v, i
             from unnest(string_to_array(s.value, E'\n')) with ordinality as a(e, i) where trim(e) <> ''
             order by lower(app_full_title(e)), i) x) v
    from settings s where s.key like 'pastors:%')
  update settings s set value = t.v from t where s.key = t.key and s.value is distinct from t.v;
  get diagnostics l = row_count;
  with t as (
    select id, (select string_agg(app_full_title(e), ', ' order by i) from unnest(string_to_array(pastor, ',')) with ordinality as a(e, i) where trim(e) <> '') v
    from members where coalesce(pastor, '') <> '')
  update members x set pastor = t.v, version = x.version + 1 from t where x.id = t.id and x.pastor is distinct from t.v;
  get diagnostics m = row_count;
  update app_users set pastor = app_full_title(pastor) where coalesce(pastor, '') <> '' and pastor is distinct from app_full_title(pastor);
  get diagnostics u = row_count;
  insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
  values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'edit',
          null, null, 'tidied pastor titles: ' || l || ' lists, ' || m || ' people, ' || u || ' sign-ins', app_who(), 'done');
  return json_build_object('lists', l, 'people', m, 'signins', u);
end $$;
revoke all on function app_tidy_titles() from public, anon;
grant execute on function app_tidy_titles() to authenticated;

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
grant execute on function app_pastor_name(), app_is_mine(text, text), app_is_mine(text, text, text) to authenticated;
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

-- ---------------------------------------------------------------- Team forms: a branch sends in who should sign in
-- An admin or church admin makes a form link for a church and sends it (WhatsApp, email). The branch leader opens it
-- without signing in, lists the people who will look after that church's data (name, email, role) and sends it.
-- Nobody can sign in yet: an admin, or that church's own church admin, checks each row and approves. Only then is
-- the person added to the sign-ins. A link works for 14 days; the form can only ask for Team, Pastor or Church admin.
-- Safe to run again.
create table if not exists team_links (
  token text primary key,
  church text not null references churches(name) on update cascade on delete cascade,
  made_by text, made_by_name text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days'
);
create table if not exists team_requests (
  id uuid primary key default gen_random_uuid(),
  link text references team_links(token) on delete set null,
  church text not null references churches(name) on update cascade on delete cascade,
  sent_by text not null,
  name text not null check (length(name) between 2 and 80),
  email text not null check (email = lower(email) and length(email) <= 120),
  role text not null check (role in ('team', 'pastor', 'shepherd', 'lead')),
  pastor text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  handled_by text, handled_at timestamptz
);
create index if not exists team_requests_pending on team_requests (church) where status = 'pending';
-- a form can also ask for a Shepherd (a pastor sign-in titled Shepherd)
alter table team_requests drop constraint if exists team_requests_role_check;
alter table team_requests add constraint team_requests_role_check check (role in ('team', 'pastor', 'shepherd', 'lead'));
alter table team_links enable row level security;
alter table team_requests enable row level security;

-- who may handle a church's requests: the admin, or that church's own church admin
create or replace function app_can_team(ch text) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(app_role() = 'admin' or (app_role() = 'lead' and app_church() = ch), false) $$;

drop policy if exists "app: see team links" on team_links;
create policy "app: see team links" on team_links for select to authenticated
  using (app_can_team(church) or made_by = lower(auth.jwt() ->> 'email'));
drop policy if exists "app: see team requests" on team_requests;
create policy "app: see team requests" on team_requests for select to authenticated using (app_can_team(church));
grant select on team_links, team_requests to authenticated;
-- every change goes through the functions below
revoke insert, update, delete on team_links, team_requests from anon, authenticated;

-- Make a form link for a church (an admin, or any church admin: they may be sending it to another branch's leader).
create or replace function app_team_link(ch text) returns text
language plpgsql security definer set search_path = public as $$
declare tok text := replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
        me text := lower(auth.jwt() ->> 'email');
begin
  if app_role() not in ('admin', 'lead') or app_role() is null then raise exception 'not allowed'; end if;
  if not exists (select 1 from churches where name = ch) then raise exception 'there is no church called %', ch; end if;
  if (select count(*) from team_links where made_by = me and created_at > now() - interval '1 day') >= 20 then
    raise exception 'You have made 20 links today. Please use one of those.';
  end if;
  insert into team_links (token, church, made_by, made_by_name)
  values (tok, ch, me, (select coalesce(nullif(trim(name), ''), email) from app_users where email = me));
  return tok;
end $$;

-- What the form shows before anyone fills it in: which church, who sent it, until when. Null for a wrong or old link.
create or replace function app_team_form(tok text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('church', l.church, 'by', l.made_by_name, 'until', l.expires_at,
                           'sent', (select count(*) from team_requests r where r.link = l.token))
  from team_links l where l.token = tok and l.expires_at > now() $$;

-- The form is sent: up to 50 people at once, 150 per link in all. Each needs a name, an email and a role.
create or replace function app_team_submit(tok text, from_name text, people json) returns int
language plpgsql security definer set search_path = public as $$
declare l team_links; p json; n int := 0; em text; nm text; rl text; pn text;
        who text := left(trim(regexp_replace(coalesce(from_name, ''), '\s+', ' ', 'g')), 80);
begin
  select * into l from team_links where token = tok and expires_at > now();
  if l.token is null then raise exception 'This form link has expired. Ask for a new one.'; end if;
  if length(who) < 2 then raise exception 'Type your own name at the top.'; end if;
  if json_typeof(people) <> 'array' or json_array_length(people) = 0 then raise exception 'Add at least one person.'; end if;
  if json_array_length(people) > 50 then raise exception 'Send at most 50 people at a time.'; end if;
  if (select count(*) from team_requests where link = tok) + json_array_length(people) > 150 then
    raise exception 'This link has had 150 people already. Ask for a new one.';
  end if;
  for p in select * from json_array_elements(people) loop
    nm := left(trim(regexp_replace(coalesce(p ->> 'name', ''), '\s+', ' ', 'g')), 80);
    em := lower(trim(coalesce(p ->> 'email', '')));
    rl := coalesce(p ->> 'role', '');
    pn := nullif(left(trim(regexp_replace(coalesce(p ->> 'pastor', ''), '\s+', ' ', 'g')), 80), '');
    if length(nm) < 2 then raise exception 'Every person needs a name.'; end if;
    if em !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' or length(em) > 120 then
      raise exception '% needs a proper email address.', nm;
    end if;
    if rl not in ('team', 'pastor', 'shepherd', 'lead') then raise exception 'Pick a role for %.', nm; end if;
    -- the same email sent again on this link and still waiting: keep the newest details
    delete from team_requests where link = tok and email = em and status = 'pending';
    insert into team_requests (link, church, sent_by, name, email, role, pastor)
    values (tok, l.church, who, nm, em, rl, case when rl in ('pastor', 'shepherd') then coalesce(pn, nm) else pn end);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Approve: each item is {id, role, pastor}; the role and pastor name can be changed before approving. All or nothing.
-- Someone who can already sign in is left exactly as they are (their request is just closed).
-- Returns how many were added and how many could already sign in.
create or replace function app_team_approve(items json, at_txt text default null) returns json
language plpgsql security definer set search_path = public as $$
declare it json; r team_requests; rl text; pn text; added int := 0; had int := 0; who text := app_who();
        stamp text := left(coalesce(nullif(trim(at_txt), ''), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')), 40);
begin
  if app_role() not in ('admin', 'lead') or app_role() is null then raise exception 'not allowed'; end if;
  for it in select * from json_array_elements(items) loop
    update team_requests set status = 'approved', handled_by = who, handled_at = now()
     where id = (it ->> 'id')::uuid and status = 'pending' and app_can_team(church) returning * into r;
    if not found then raise exception 'already handled'; end if;
    rl := coalesce(nullif(it ->> 'role', ''), r.role);
    if rl not in ('team', 'pastor', 'shepherd', 'lead') then raise exception 'that role cannot be given here'; end if;
    pn := nullif(trim(regexp_replace(coalesce(it ->> 'pastor', r.pastor, ''), '\s+', ' ', 'g')), '');
    if rl in ('pastor', 'shepherd') and pn is null then raise exception '% needs their name as it is on the % list', r.name, case when rl = 'shepherd' then 'Shepherds' else 'Pastors' end; end if;
    if exists (select 1 from app_users where email = r.email) then had := had + 1; continue; end if;
    if rl = 'shepherd' then  -- a shepherd goes on the church's Shepherds list too (if not there yet), so people can be given to them
      insert into settings (key, value) values ('shepherds:' || r.church, pn)
      on conflict (key) do update set value = settings.value || E'\n' || pn
        where not exists (select 1 from unnest(string_to_array(settings.value, E'\n')) x where lower(trim(x)) = lower(pn));
    end if;
    insert into app_users (email, role, church, name, pastor, title)  -- a shepherd signs in as a pastor, titled Shepherd
    values (r.email, case when rl = 'shepherd' then 'pastor' else rl end, r.church, r.name, case when rl in ('pastor', 'shepherd') then app_full_title(pn) end,
            case when rl = 'shepherd' then 'Shepherd' end);
    insert into activity_log (id, at, kind, service_date, member_id, detail, by_name, result)
    values (substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), stamp, 'role_change', null, null,
            left(r.email || ': ' || r.name || ' · ' || case rl when 'lead' then 'Church admin' when 'pastor' then 'Pastor' when 'shepherd' then 'Shepherd' else 'Team' end
                 || ' · ' || r.church || ' (team form from ' || r.sent_by || ')', 300), who, 'done');
    added := added + 1;
  end loop;
  return json_build_object('added', added, 'had', had);
end $$;

-- Turn requests down. Returns how many were still waiting.
create or replace function app_team_reject(ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if app_role() not in ('admin', 'lead') or app_role() is null then raise exception 'not allowed'; end if;
  update team_requests set status = 'rejected', handled_by = app_who(), handled_at = now()
   where id = any(ids) and status = 'pending' and app_can_team(church);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function app_can_team(text), app_team_link(text), app_team_form(text), app_team_submit(text, text, json),
  app_team_approve(json, text), app_team_reject(uuid[]) from public, anon;
grant execute on function app_team_form(text), app_team_submit(text, text, json) to anon, authenticated;
grant execute on function app_can_team(text), app_team_link(text), app_team_approve(json, text), app_team_reject(uuid[]) to authenticated;

notify pgrst, 'reload schema';
