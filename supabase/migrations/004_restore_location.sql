-- Active path: room location, rotating token, and the 30 second grace period.
-- The Bluetooth overloads from 003_ble.sql stay in the database on standby.

create or replace function public.auto_mark(
  p_secret text,
  p_session_id uuid,
  p_token text,
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
  h text;
  dist numeric;
  epoch bigint;
  expected_now text;
  expected_prev text;
  token_ok boolean;
  existing uuid;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;

  update public.sessions set status = 'closed' where status = 'live' and ends_at <= now();

  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'student' then
    return jsonb_build_object('ok', false, 'reason', 'role');
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

  select * into s from public.sessions where id = p_session_id;
  if not found or s.status <> 'live' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if s.last_beacon_at is null or s.last_beacon_at < now() - interval '12 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'silent');
  end if;

  select a.id into existing
  from public.attendance a
  where a.session_id = s.id and a.student_id = uid;
  if existing is not null then
    return jsonb_build_object('ok', true, 'reason', 'already');
  end if;

  epoch := floor(extract(epoch from now()) / 5)::bigint;
  if p_token is not null and length(trim(p_token)) > 0 then
    expected_now := public.beacon_token(s.id, epoch);
    expected_prev := public.beacon_token(s.id, epoch - 1);
    token_ok := p_token = expected_now or p_token = expected_prev;
    if not token_ok then
      return jsonb_build_object('ok', false, 'reason', 'stale');
    end if;
  end if;

  dist := null;
  if s.latitude is not null and s.longitude is not null then
    if p_lat is null or p_lng is null then
      return jsonb_build_object('ok', false, 'reason', 'noloc');
    end if;
    if p_accuracy is not null and p_accuracy > 120 then
      return jsonb_build_object('ok', false, 'reason', 'fuzzy');
    end if;
    dist := public.haversine_m(p_lat, p_lng, s.latitude, s.longitude);
    if dist > s.radius_meters then
      return jsonb_build_object('ok', false, 'reason', 'far', 'distance', dist);
    end if;
  elsif p_rssi is null or p_rssi < -70 then
    return jsonb_build_object('ok', false, 'reason', 'far');
  end if;

  if p_rssi is not null and p_rssi < -78 then
    return jsonb_build_object('ok', false, 'reason', 'weak', 'distance', dist);
  end if;

  insert into public.attendance (
    session_id, student_id, device_id, rssi, distance_meters, method, token_epoch
  )
  values (s.id, uid, dev.id, p_rssi, dist, 'auto', epoch);

  return jsonb_build_object('ok', true, 'reason', 'marked', 'epoch', epoch, 'distance', dist);
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'reason', 'already');
end;
$$;

grant execute on function public.auto_mark(text, uuid, text, double precision, double precision, integer, double precision) to authenticated;
revoke all on function public.auto_mark(text, uuid, text, double precision, double precision, integer, double precision) from public, anon;

-- The location presence_ping from 002 is recreated here because 003 dropped that signature.
-- Bluetooth auto_mark and presence_ping overloads from 003 remain beside these.
