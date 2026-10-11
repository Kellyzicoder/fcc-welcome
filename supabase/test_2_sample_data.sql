-- TEST DATABASE ONLY. Step 3 of 3: made-up people and attendance for trying the app safely.
-- Never run this on the real database. Every name and phone number here is invented.
--
-- BEFORE RUNNING: change you@example.com (two lines below) to the email you sign in with.
-- Running it again wipes the test data and starts fresh.

do $$
declare
  my_email text := lower('you@example.com');          -- <-- your email: you become Admin of the test app
  pastor_email text := lower('pastor@example.com');   -- optional: a second email to try a Pastor sign-in
  first text[] := array['Ama','Kwame','Esi','Kojo','Abena','Yaw','Akosua','Kofi','Adwoa','Kwabena','Efua','Kwaku',
                        'Afia','Kweku','Aba','Fiifi','Naana','Paa','Serwaa','Ekow','Mia','Leo','Zoe','Eli','Ruth',
                        'Noah','Tia','Sam','Joy','Ben'];
  female text[] := array['Ama','Esi','Abena','Akosua','Adwoa','Efua','Afia','Aba','Naana','Serwaa','Mia','Zoe','Ruth','Tia','Joy'];
  last text[] := array['Asante','Owusu','Boateng','Appiah','Darko','Ofori','Quaye','Tetteh','Addo','Badu'];
  roles text[] := array['Worship Team','Ushers','Tech Team','Choir','Children''s Church Teacher','Media','', '', '', ''];
  churches text[] := array['Auckland','Melbourne','Sydney'];
  sizes int[] := array[40, 12, 8];
  pastors jsonb := '{"Auckland":["Pastor Ama Owusu","Pastor Kofi Mensah","Pastor Esi Darko"],"Melbourne":["Pastor Yaw Boateng"],"Sydney":["Pastor Joy Addo"]}';
  sundays date[]; wednesdays date[]; d date; ch text; n int; k int := 0; mid text; fn text; typ text; stop_at int;
  plist jsonb;
begin
  -- start fresh
  delete from attendance; delete from activity_log; delete from services; delete from members;
  delete from registrations; delete from email_log;
  delete from settings where key like 'pastors:%' or key like 'lock:%';
  insert into settings (key, value) values ('home_church', 'Auckland') on conflict (key) do update set value = excluded.value;
  insert into settings (key, value) values ('help_contact', 'Test admin · 021 000 0000') on conflict (key) do update set value = excluded.value;

  select array_agg(x::date order by x) into sundays
    from generate_series(date_trunc('week', current_date)::date - 1 - 77, date_trunc('week', current_date)::date - 1, interval '7 day') x;
  select array_agg(x::date order by x) into wednesdays
    from generate_series(date_trunc('week', current_date)::date + 2 - 28, date_trunc('week', current_date)::date - 5, interval '7 day') x;
  foreach d in array sundays loop insert into services values (d, 'Sunday Service') on conflict do nothing; end loop;
  foreach d in array wednesdays loop insert into services values (d, 'Midweek Service') on conflict do nothing; end loop;

  for c in 1..array_length(churches, 1) loop
    ch := churches[c];
    insert into churches (name) values (ch) on conflict do nothing;
    plist := pastors -> ch;
    insert into settings (key, value) values ('pastors:' || ch, (select string_agg(v, E'\n') from jsonb_array_elements_text(plist) v))
      on conflict (key) do update set value = excluded.value;
    for i in 1..sizes[c] loop
      k := k + 1;
      fn := first[1 + (k * 7) % array_length(first, 1)] || ' ' || last[1 + (k * 3) % array_length(last, 1)];
      mid := 'test' || lpad(k::text, 4, '0');
      typ := case when i % 13 = 0 then 'visitor' when i % 9 = 0 then 'first_timer' else 'member' end;
      insert into members (id, full_name, phone, type, status, role, age_group, gender, pastor, church,
                           date_joined, first_visit, created_at)
      values (mid, fn, '021 000 ' || lpad((1000 + k)::text, 4, '0'), typ,
              case when i % 17 = 0 then 'Away' else '' end,
              nullif(roles[1 + i % array_length(roles, 1)], ''),
              case when i % 8 = 0 then 'Child' else 'Adult' end,
              case when split_part(fn, ' ', 1) = any(female) then 'Female' else 'Male' end,
              case when i % 6 = 0 then null else plist ->> ((i % jsonb_array_length(plist))) end,
              case when ch = 'Auckland' then null else ch end,
              case when typ = 'member' then sundays[1] - 200 end,
              case when typ <> 'member' then sundays[1 + i % 6] end,
              to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'));
      -- who stops coming: a few miss the last 5+ Sundays (red), some the last 3 (yellow), some only the latest
      stop_at := case when i % 10 = 3 then 7 when i % 10 = 6 then 9 when i % 10 = 8 then 11 else 99 end;
      for s in 1..array_length(sundays, 1) loop
        if s < stop_at and (s + i) % 7 <> 0 and (typ = 'member' or sundays[s] >= sundays[1 + i % 6]) then
          insert into attendance values (sundays[s], mid, sundays[s]::text || 'T10:' || lpad((i % 60)::text, 2, '0') || ':00+13:00');
        end if;
      end loop;
      foreach d in array wednesdays loop
        if i % 3 = 0 and typ = 'member' then insert into attendance values (d, mid, d::text || 'T19:30:00+13:00'); end if;
      end loop;
    end loop;
  end loop;

  -- two waiting sign-ups from the welcome form
  insert into registrations (full_name, phone, email, invited_by, first_visit, notes, status)
  values ('Test Visitor One', '0210001111', 'visitor1@example.com', 'A friend', sundays[12], 'Testing the welcome form', 'pending'),
         ('Test Visitor Two', '0210002222', '', '', sundays[12], '', 'pending');

  -- sign-ins for the test app
  insert into app_users (email, role, church, name) values (my_email, 'admin', null, 'Test Admin')
    on conflict (email) do update set role = 'admin', church = null;
  insert into app_users (email, role, church, name, pastor) values (pastor_email, 'pastor', 'Auckland', 'Test Pastor', 'Pastor Ama Owusu')
    on conflict (email) do update set role = 'pastor', church = 'Auckland', pastor = 'Pastor Ama Owusu';
end $$;

select (select count(*) from members) as people, (select count(*) from services) as services,
       (select count(*) from attendance) as ticks, (select string_agg(email || ' = ' || role, ', ') from app_users) as sign_ins;
