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

-- ---------------------------------------------------------------- first church and first admin
insert into churches (name) values (app_home_church()) on conflict do nothing;
-- Then add yourself as the first admin (use your own email, lower case):
--   insert into app_users (email, role, name) values ('you@example.com', 'admin', 'Your Name') on conflict (email) do update set role = 'admin';

notify pgrst, 'reload schema';
