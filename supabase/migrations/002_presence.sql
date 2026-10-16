-- Keep tracking a student after the first mark. Leaving the room starts a 30s grace period.

alter table public.attendance
  add column if not exists presence text not null default 'present' check (presence in ('present', 'grace', 'absent')),
  add column if not exists last_seen_at timestamptz,
  add column if not exists grace_until timestamptz,
  add column if not exists absent_at timestamptz;

update public.attendance
set last_seen_at = marked_at
where method = 'auto' and last_seen_at is null;

grant select (presence, last_seen_at, grace_until, absent_at) on public.attendance to authenticated;

create or replace function public.stamp_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.presence is null then
    new.presence := 'present';
  end if;
  if new.method = 'auto' and new.last_seen_at is null then
    new.last_seen_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_attendance_row on public.attendance;
create trigger stamp_attendance_row
  before insert on public.attendance
  for each row execute function public.stamp_attendance();

create or replace function public.sweep_presence()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.attendance a
  set presence = 'absent',
      absent_at = coalesce(a.absent_at, now()),
      grace_until = null
  from public.sessions s
  where a.session_id = s.id
    and s.status = 'live'
    and a.method = 'auto'
    and a.presence = 'present'
    and a.last_seen_at is not null
    and a.last_seen_at < now() - interval '30 seconds';

  update public.attendance
  set presence = 'absent',
      absent_at = coalesce(absent_at, now()),
      grace_until = null
  where presence = 'grace'
    and grace_until is not null
    and grace_until <= now();
end;
$$;

create or replace function public.presence_ping(
  p_secret text,
  p_session_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_rssi integer,
  p_accuracy double precision
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
  dist numeric;
  in_room boolean := false;
  seconds_left integer;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;

  perform public.sweep_presence();

  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'student' then
    return jsonb_build_object('ok', false, 'reason', 'role');
  end if;

  h := public.device_hash(p_secret);
  select * into dev from public.devices where secret_hash = h;
  if not found or dev.user_id <> uid or dev.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'unbound');
  end if;

  select * into s from public.sessions where id = p_session_id;
  if not found or s.status <> 'live' or s.ends_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  select * into row
  from public.attendance
  where session_id = s.id and student_id = uid;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unmarked');
  end if;

  if row.presence = 'absent' then
    return jsonb_build_object('ok', true, 'reason', 'absent');
  end if;

  dist := null;
  if s.latitude is not null and s.longitude is not null then
    if p_lat is not null and p_lng is not null and (p_accuracy is null or p_accuracy <= 120) then
      dist := public.haversine_m(p_lat, p_lng, s.latitude, s.longitude);
      in_room := dist <= s.radius_meters;
    end if;
  else
    in_room := p_rssi is not null and p_rssi >= -70 and p_rssi <= 0;
  end if;

  if p_rssi is not null and p_rssi < -78 then
    in_room := false;
  end if;

  if in_room then
    update public.attendance
    set presence = 'present',
        last_seen_at = now(),
        grace_until = null,
        distance_meters = coalesce(dist, distance_meters),
        rssi = coalesce(p_rssi, rssi)
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'present', 'distance', dist);
  end if;

  if row.presence = 'grace' and row.grace_until is not null and row.grace_until <= now() then
    update public.attendance
    set presence = 'absent',
        absent_at = now(),
        grace_until = null,
        last_seen_at = now(),
        distance_meters = coalesce(dist, distance_meters)
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'absent', 'distance', dist);
  end if;

  if row.presence = 'present' or row.grace_until is null then
    update public.attendance
    set presence = 'grace',
        grace_until = now() + interval '30 seconds',
        last_seen_at = now(),
        distance_meters = coalesce(dist, distance_meters),
        rssi = coalesce(p_rssi, rssi)
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', 30, 'distance', dist);
  end if;

  update public.attendance
  set last_seen_at = now(),
      distance_meters = coalesce(dist, distance_meters),
      rssi = coalesce(p_rssi, rssi)
  where id = row.id;

  seconds_left := greatest(0, ceil(extract(epoch from (row.grace_until - now())))::integer);
  return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', seconds_left, 'distance', dist);
end;
$$;

create or replace function public.manual_mark(p_session_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  student_role text;
  s public.sessions;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can mark someone by hand';
  end if;
  select * into s from public.sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found';
  end if;
  if s.organiser_id <> uid then
    raise exception 'This session belongs to another organiser';
  end if;
  if s.status <> 'live' or s.ends_at <= now() then
    raise exception 'This session is closed';
  end if;
  select p.role into student_role from public.profiles p where p.id = p_student_id;
  if student_role is distinct from 'student' then
    raise exception 'That person is not a student';
  end if;

  update public.attendance
  set presence = 'present',
      grace_until = null,
      absent_at = null,
      method = 'manual',
      last_seen_at = null
  where session_id = s.id and student_id = p_student_id;

  if found then
    return jsonb_build_object('ok', true, 'reason', 'marked');
  end if;

  insert into public.attendance (session_id, student_id, method, token_epoch, presence)
  values (s.id, p_student_id, 'manual', floor(extract(epoch from now()) / 5)::bigint, 'present');

  return jsonb_build_object('ok', true, 'reason', 'marked');
end;
$$;

create or replace function public.beacon_pulse(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  epoch bigint;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;

  perform public.sweep_presence();

  select * into s from public.sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found';
  end if;
  if s.organiser_id <> uid then
    raise exception 'Only the organiser can broadcast';
  end if;
  if s.status <> 'live' or s.ends_at <= now() then
    update public.sessions set status = 'closed' where id = s.id and status <> 'closed';
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  update public.sessions set last_beacon_at = now() where id = s.id;
  epoch := floor(extract(epoch from now()) / 5)::bigint;

  return jsonb_build_object(
    'ok', true,
    'epoch', epoch,
    'ttl', 5 - (floor(extract(epoch from now()))::bigint % 5),
    'token', public.beacon_token(s.id, epoch)
  );
end;
$$;

create or replace function public.close_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can close a session';
  end if;

  perform public.sweep_presence();

  update public.attendance
  set presence = 'absent',
      absent_at = coalesce(absent_at, now()),
      grace_until = null
  where session_id = p_session_id and presence = 'grace';

  update public.sessions
    set status = 'closed',
        ends_at = least(ends_at, now())
    where id = p_session_id and organiser_id = uid;

  if not found then
    raise exception 'Session not found';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.stamp_attendance() from public, anon, authenticated;
revoke all on function public.sweep_presence() from public, anon, authenticated;
revoke all on function public.presence_ping(text, uuid, double precision, double precision, integer, double precision) from public, anon;
grant execute on function public.presence_ping(text, uuid, double precision, double precision, integer, double precision) to authenticated;
