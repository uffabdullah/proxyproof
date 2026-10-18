drop trigger if exists auto_confirm_before_insert on auth.users;

create or replace function public.email_taken(p_email text)
returns boolean
language sql
stable
security definer
set search_path = auth, public
as $$
  select exists (
    select 1 from auth.users u
    where lower(u.email) = lower(trim(coalesce(p_email, '')))
  );
$$;

create or replace function public.rssi_limit(meters integer)
returns integer
language sql
immutable
as $$
  select case when coalesce(meters, 5) <= 3 then -60 else -68 end;
$$;

do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.sessions'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%radius_meters%'
  loop
    execute format('alter table public.sessions drop constraint %I', r.conname);
  end loop;
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.attendance'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%presence%'
  loop
    execute format('alter table public.attendance drop constraint %I', r.conname);
  end loop;
end $$;

update public.sessions
set radius_meters = 5
where radius_meters > 5 or radius_meters < 3;

alter table public.sessions
  add constraint sessions_radius_meters_check check (radius_meters between 3 and 5);

alter table public.attendance
  add constraint attendance_presence_check check (presence in ('present', 'grace', 'absent', 'joined'));

create or replace function public.start_session(
  p_title text,
  p_course text,
  p_duration integer,
  p_lat double precision,
  p_lng double precision,
  p_radius integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  sid uuid;
  dur integer;
  rad integer;
  title text;
  course text;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can start a session';
  end if;

  update public.sessions
    set status = 'closed'
    where status = 'live' and ends_at <= now();

  title := trim(coalesce(p_title, ''));
  course := trim(coalesce(p_course, ''));
  if title = '' then
    raise exception 'Give the session a title';
  end if;
  if course = '' then
    course := 'General';
  end if;
  dur := least(3000, greatest(1800, coalesce(p_duration, 2400)));
  rad := least(5, greatest(3, coalesce(p_radius, 5)));

  insert into public.sessions (
    organiser_id, title, course, duration_seconds, started_at, ends_at,
    status, latitude, longitude, radius_meters, last_beacon_at
  )
  values (
    uid, left(title, 120), left(course, 80), dur, now(), now() + make_interval(secs => dur),
    'live', p_lat, p_lng, rad, now()
  )
  returning id into sid;

  return sid;
end;
$$;

create or replace function public.join_class(p_session_id uuid, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  dev public.devices;
  s public.sessions;
  row public.attendance;
  h text;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'student' then
    return jsonb_build_object('ok', false, 'reason', 'role');
  end if;

  h := public.device_hash(p_secret);
  select * into dev from public.devices where secret_hash = h;
  if not found or dev.user_id <> uid then
    return jsonb_build_object('ok', false, 'reason', 'unbound');
  end if;
  if dev.status = 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'pending');
  end if;
  if dev.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;

  select * into s from public.sessions where id = p_session_id;
  if not found or s.status <> 'live' or s.ends_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  select * into row from public.attendance where session_id = s.id and student_id = uid;
  if found then
    if row.presence = 'absent' then
      update public.attendance
      set presence = 'joined',
          absent_at = null,
          grace_until = null,
          last_seen_at = null,
          method = 'auto'
      where id = row.id;
      return jsonb_build_object('ok', true, 'reason', 'joined', 'session_id', s.id, 'title', s.title, 'course', s.course);
    end if;
    return jsonb_build_object('ok', true, 'reason', row.presence, 'session_id', s.id, 'title', s.title, 'course', s.course);
  end if;

  insert into public.attendance (session_id, student_id, device_id, method, token_epoch, presence)
  values (s.id, uid, dev.id, 'auto', floor(extract(epoch from now()) / 5)::bigint, 'joined');

  return jsonb_build_object('ok', true, 'reason', 'joined', 'session_id', s.id, 'title', s.title, 'course', s.course);
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'reason', 'joined', 'session_id', p_session_id);
end;
$$;

create or replace function public.auto_mark(
  p_secret text,
  p_session_id uuid,
  p_token text,
  p_student_id uuid,
  p_rssi integer,
  p_session_prefix text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  dev public.devices;
  s public.sessions;
  row public.attendance;
  h text;
  epoch bigint;
  threshold integer;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  update public.sessions set status = 'closed' where status = 'live' and ends_at <= now();

  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'student' then
    return jsonb_build_object('ok', false, 'reason', 'role');
  end if;
  if p_student_id is null or p_student_id <> uid then
    return jsonb_build_object('ok', false, 'reason', 'stolen');
  end if;

  h := public.device_hash(p_secret);
  select * into dev from public.devices where secret_hash = h;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unbound');
  end if;
  if dev.user_id <> uid then
    return jsonb_build_object('ok', false, 'reason', 'stolen');
  end if;
  if dev.status = 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'pending');
  end if;
  if dev.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;

  s := public.resolve_live_session(p_session_id, p_session_prefix);
  if s is null or s.id is null or s.status <> 'live' then
    return jsonb_build_object('ok', false, 'reason', 'silent');
  end if;
  if s.last_beacon_at is null or s.last_beacon_at < now() - interval '12 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'silent', 'session_id', s.id);
  end if;

  threshold := public.rssi_limit(s.radius_meters);
  select * into row from public.attendance where session_id = s.id and student_id = uid;
  if found then
    if row.presence = 'absent' then
      return jsonb_build_object('ok', true, 'reason', 'absent', 'session_id', s.id, 'presence', 'absent');
    end if;
    if public.token_matches(s.id, p_token) and p_rssi is not null and p_rssi >= threshold and p_rssi <= 0 then
      update public.attendance
      set presence = 'present',
          last_seen_at = now(),
          grace_until = null,
          rssi = p_rssi,
          device_id = dev.id
      where id = row.id;
      return jsonb_build_object('ok', true, 'reason', 'present', 'session_id', s.id, 'rssi', p_rssi, 'title', s.title, 'course', s.course);
    end if;
    if row.presence = 'joined' then
      return jsonb_build_object('ok', true, 'reason', 'joined', 'session_id', s.id, 'title', s.title, 'course', s.course);
    end if;
    return jsonb_build_object('ok', true, 'reason', 'already', 'session_id', s.id, 'presence', row.presence);
  end if;

  if not public.token_matches(s.id, p_token) then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'session_id', s.id);
  end if;
  if p_rssi is null or p_rssi < threshold or p_rssi > 0 then
    return jsonb_build_object('ok', false, 'reason', 'weak', 'session_id', s.id, 'rssi', p_rssi);
  end if;

  epoch := floor(extract(epoch from now()) / 5)::bigint;
  insert into public.attendance (
    session_id, student_id, device_id, rssi, method, token_epoch, presence, last_seen_at
  ) values (
    s.id, uid, dev.id, p_rssi, 'auto', epoch, 'present', now()
  );
  return jsonb_build_object('ok', true, 'reason', 'marked', 'session_id', s.id, 'rssi', p_rssi, 'title', s.title, 'course', s.course);
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'reason', 'already', 'session_id', s.id);
end;
$$;

create or replace function public.presence_ping(
  p_secret text,
  p_session_id uuid,
  p_token text,
  p_student_id uuid,
  p_rssi integer,
  p_session_prefix text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  dev public.devices;
  s public.sessions;
  row public.attendance;
  h text;
  in_room boolean;
  seconds_left integer;
  threshold integer;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  perform public.sweep_presence();
  if p_student_id is null or p_student_id <> uid then
    return jsonb_build_object('ok', false, 'reason', 'stolen');
  end if;

  h := public.device_hash(p_secret);
  select * into dev from public.devices where secret_hash = h;
  if not found or dev.user_id <> uid or dev.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'unbound');
  end if;

  s := public.resolve_live_session(p_session_id, p_session_prefix);
  if s is null or s.id is null or s.status <> 'live' or s.ends_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  threshold := public.rssi_limit(s.radius_meters);
  select * into row from public.attendance where session_id = s.id and student_id = uid;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unmarked', 'session_id', s.id);
  end if;
  if row.presence = 'absent' then
    return jsonb_build_object('ok', true, 'reason', 'absent', 'session_id', s.id);
  end if;

  in_room := p_rssi is not null
    and p_rssi >= threshold
    and p_rssi <= 0
    and public.token_matches(s.id, p_token);

  if row.presence = 'joined' then
    if in_room then
      update public.attendance
      set presence = 'present', last_seen_at = now(), grace_until = null, rssi = p_rssi
      where id = row.id;
      return jsonb_build_object('ok', true, 'reason', 'present', 'session_id', s.id, 'rssi', p_rssi, 'title', s.title, 'course', s.course);
    end if;
    if p_rssi is not null and p_rssi < threshold and p_rssi > -127 and public.token_matches(s.id, p_token) then
      update public.attendance
      set presence = 'grace',
          grace_until = now() + interval '30 seconds',
          last_seen_at = now(),
          rssi = p_rssi
      where id = row.id;
      return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', 30, 'session_id', s.id, 'title', s.title);
    end if;
    return jsonb_build_object('ok', true, 'reason', 'joined', 'session_id', s.id, 'title', s.title, 'course', s.course);
  end if;

  if in_room then
    update public.attendance
    set presence = 'present',
        last_seen_at = now(),
        grace_until = null,
        rssi = p_rssi
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'present', 'session_id', s.id, 'rssi', p_rssi, 'title', s.title, 'course', s.course);
  end if;

  if row.presence = 'grace' and row.grace_until is not null and row.grace_until <= now() then
    update public.attendance
    set presence = 'absent', absent_at = now(), grace_until = null, last_seen_at = now(), rssi = p_rssi
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'absent', 'session_id', s.id, 'title', s.title);
  end if;

  if row.presence = 'present' or row.grace_until is null then
    update public.attendance
    set presence = 'grace',
        grace_until = now() + interval '30 seconds',
        last_seen_at = now(),
        rssi = p_rssi
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', 30, 'session_id', s.id, 'title', s.title);
  end if;

  update public.attendance
  set last_seen_at = now(), rssi = coalesce(p_rssi, rssi)
  where id = row.id;

  seconds_left := greatest(0, ceil(extract(epoch from (row.grace_until - now())))::integer);
  return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', seconds_left, 'session_id', s.id, 'title', s.title);
end;
$$;

revoke all on function public.email_taken(text) from public;
grant execute on function public.email_taken(text) to anon, authenticated;
revoke all on function public.rssi_limit(integer) from public, anon, authenticated;
revoke all on function public.join_class(uuid, text) from public, anon;
grant execute on function public.join_class(uuid, text) to authenticated;

notify pgrst, 'reload schema';
