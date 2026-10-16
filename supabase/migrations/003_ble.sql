-- A mark counts only with a fresh beacon token, the registered device, and in-room RSSI.

drop function if exists public.auto_mark(text, uuid, text, double precision, double precision, integer, double precision);
drop function if exists public.presence_ping(text, uuid, double precision, double precision, integer, double precision);

create or replace function public.resolve_live_session(p_session_id uuid, p_session_prefix text)
returns public.sessions
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.sessions;
  n integer;
begin
  if p_session_id is not null then
    select * into s from public.sessions where id = p_session_id;
    return s;
  end if;
  if p_session_prefix is null or length(p_session_prefix) < 8 then
    return null;
  end if;
  select count(*) into n
  from public.sessions
  where status = 'live'
    and ends_at > now()
    and replace(id::text, '-', '') ilike p_session_prefix || '%';
  if n <> 1 then
    return null;
  end if;
  select * into s
  from public.sessions
  where status = 'live'
    and ends_at > now()
    and replace(id::text, '-', '') ilike p_session_prefix || '%';
  return s;
end;
$$;

create or replace function public.token_matches(p_session_id uuid, p_token text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  epoch bigint;
  now_token text;
  prev_token text;
  given text;
begin
  if p_token is null or length(trim(p_token)) < 8 then
    return false;
  end if;
  given := lower(trim(p_token));
  epoch := floor(extract(epoch from now()) / 5)::bigint;
  now_token := lower(public.beacon_token(p_session_id, epoch));
  prev_token := lower(public.beacon_token(p_session_id, epoch - 1));
  return given = now_token
    or given = prev_token
    or now_token like given || '%'
    or prev_token like given || '%';
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

  select * into row from public.attendance where session_id = s.id and student_id = uid;
  if found then
    return jsonb_build_object(
      'ok', true,
      'reason', case when row.presence = 'absent' then 'absent' else 'already' end,
      'session_id', s.id,
      'presence', row.presence
    );
  end if;

  if not public.token_matches(s.id, p_token) then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'session_id', s.id);
  end if;
  if p_rssi is null or p_rssi < -70 or p_rssi > 0 then
    return jsonb_build_object('ok', false, 'reason', 'weak', 'session_id', s.id);
  end if;

  epoch := floor(extract(epoch from now()) / 5)::bigint;
  insert into public.attendance (
    session_id, student_id, device_id, rssi, method, token_epoch, presence, last_seen_at
  ) values (
    s.id, uid, dev.id, p_rssi, 'auto', epoch, 'present', now()
  );
  return jsonb_build_object('ok', true, 'reason', 'marked', 'session_id', s.id, 'rssi', p_rssi);
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

  select * into row from public.attendance where session_id = s.id and student_id = uid;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unmarked', 'session_id', s.id);
  end if;
  if row.presence = 'absent' then
    return jsonb_build_object('ok', true, 'reason', 'absent', 'session_id', s.id);
  end if;

  in_room := p_rssi is not null
    and p_rssi >= -70
    and p_rssi <= 0
    and public.token_matches(s.id, p_token);

  if in_room then
    update public.attendance
    set presence = 'present',
        last_seen_at = now(),
        grace_until = null,
        rssi = p_rssi
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'present', 'session_id', s.id, 'rssi', p_rssi);
  end if;

  if row.presence = 'grace' and row.grace_until is not null and row.grace_until <= now() then
    update public.attendance
    set presence = 'absent', absent_at = now(), grace_until = null, last_seen_at = now(), rssi = p_rssi
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'absent', 'session_id', s.id);
  end if;

  if row.presence = 'present' or row.grace_until is null then
    update public.attendance
    set presence = 'grace',
        grace_until = now() + interval '30 seconds',
        last_seen_at = now(),
        rssi = p_rssi
    where id = row.id;
    return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', 30, 'session_id', s.id);
  end if;

  update public.attendance
  set last_seen_at = now(), rssi = coalesce(p_rssi, rssi)
  where id = row.id;

  seconds_left := greatest(0, ceil(extract(epoch from (row.grace_until - now())))::integer);
  return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', seconds_left, 'session_id', s.id);
end;
$$;

revoke all on function public.resolve_live_session(uuid, text) from public, anon, authenticated;
revoke all on function public.token_matches(uuid, text) from public, anon, authenticated;
revoke all on function public.auto_mark(text, uuid, text, uuid, integer, text) from public, anon;
revoke all on function public.presence_ping(text, uuid, text, uuid, integer, text) from public, anon;
grant execute on function public.auto_mark(text, uuid, text, uuid, integer, text) to authenticated;
grant execute on function public.presence_ping(text, uuid, text, uuid, integer, text) to authenticated;

notify pgrst, 'reload schema';
