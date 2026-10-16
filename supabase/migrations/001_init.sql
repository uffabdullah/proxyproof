-- ProxyProof: rotating beacon, one device per student, presence-checked attendance.

create extension if not exists pgcrypto with schema extensions;

create table public.app_config (
  key text primary key,
  value text not null
);

alter table public.app_config enable row level security;
revoke all on public.app_config from public, anon, authenticated;

insert into public.app_config (key, value)
values ('token_pepper', encode(extensions.gen_random_bytes(32), 'hex'));

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  role text not null check (role in ('organiser', 'student')),
  student_code text unique,
  created_at timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  secret_hash text not null unique,
  label text,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create unique index devices_one_active_per_user
  on public.devices (user_id)
  where status = 'active';

create index devices_user_idx on public.devices (user_id);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references public.profiles (id),
  title text not null,
  course text not null default 'General',
  duration_seconds integer not null default 300 check (duration_seconds between 60 and 7200),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  status text not null default 'live' check (status in ('live', 'closed')),
  latitude double precision,
  longitude double precision,
  radius_meters integer not null default 50 check (radius_meters between 15 and 200),
  last_beacon_at timestamptz,
  created_at timestamptz not null default now()
);

create index sessions_status_idx on public.sessions (status, ends_at desc);
create index sessions_organiser_idx on public.sessions (organiser_id);

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  student_id uuid not null references public.profiles (id),
  device_id uuid references public.devices (id),
  marked_at timestamptz not null default now(),
  rssi integer check (rssi is null or rssi between -120 and 0),
  distance_meters numeric,
  method text not null check (method in ('auto', 'manual')),
  token_epoch bigint,
  unique (session_id, student_id)
);

create index attendance_session_idx on public.attendance (session_id);
create index attendance_student_idx on public.attendance (student_id);

alter table public.attendance replica identity full;
alter table public.sessions replica identity full;
alter table public.devices replica identity full;

-- Secrets stay inside the database. Clients never receive the pepper.

create or replace function public.device_hash(p_secret text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  pepper text;
begin
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'Invalid device';
  end if;
  select value into pepper from public.app_config where key = 'token_pepper';
  return encode(extensions.digest(convert_to(p_secret || pepper, 'UTF8'), 'sha256'), 'hex');
end;
$$;

create or replace function public.beacon_token(p_session_id uuid, p_epoch bigint)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  pepper text;
begin
  select value into pepper from public.app_config where key = 'token_pepper';
  return encode(
    extensions.hmac(
      convert_to(p_session_id::text || ':' || p_epoch::text, 'UTF8'),
      convert_to(pepper, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
end;
$$;

create or replace function public.haversine_m(
  lat1 double precision,
  lng1 double precision,
  lat2 double precision,
  lng2 double precision
)
returns numeric
language sql
immutable
set search_path = public
as $$
  select round((
    6371000 * 2 * asin(
      least(1, sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2)
        + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
      ))
    )
  )::numeric, 1);
$$;

create or replace function public.auto_confirm_email()
returns trigger
language plpgsql
security definer
set search_path = auth, public
as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$$;

create trigger auto_confirm_before_insert
  before insert on auth.users
  for each row execute function public.auto_confirm_email();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  code text;
  person text;
begin
  r := coalesce(new.raw_user_meta_data->>'role', 'student');
  if r not in ('organiser', 'student') then
    r := 'student';
  end if;
  person := trim(coalesce(new.raw_user_meta_data->>'full_name', ''));
  if person = '' then
    person := case when r = 'organiser' then 'Organiser' else 'Student' end;
  end if;
  if char_length(person) > 80 then
    person := left(person, 80);
  end if;
  if r = 'student' then
    code := 'STU-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  insert into public.profiles (id, email, full_name, role, student_code)
  values (new.id, coalesce(new.email, ''), person, r, code);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.register_device(p_secret text, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  h text;
  row public.devices;
  has_active boolean;
  role text;
  next_status text;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'student' then
    raise exception 'Only students bind a device';
  end if;

  h := public.device_hash(p_secret);
  select exists(
    select 1 from public.devices d where d.user_id = uid and d.status = 'active'
  ) into has_active;

  select * into row from public.devices where secret_hash = h;
  if found then
    if row.user_id <> uid then
      raise exception 'This device is already bound to another student';
    end if;
    if row.status = 'revoked' then
      next_status := case when has_active then 'pending' else 'active' end;
      update public.devices
        set status = next_status,
            reviewed_at = null,
            label = coalesce(nullif(trim(p_label), ''), row.label)
        where id = row.id
        returning * into row;
    end if;
    return jsonb_build_object('id', row.id, 'status', row.status);
  end if;

  next_status := case when has_active then 'pending' else 'active' end;
  insert into public.devices (user_id, secret_hash, label, status)
  values (uid, h, coalesce(nullif(trim(p_label), ''), 'This phone'), next_status)
  returning * into row;

  return jsonb_build_object('id', row.id, 'status', row.status);
end;
$$;

create or replace function public.review_device(p_device_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  row public.devices;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can review devices';
  end if;

  select * into row from public.devices where id = p_device_id and status = 'pending';
  if not found then
    raise exception 'No pending device with that id';
  end if;

  if not coalesce(p_approve, false) then
    update public.devices
      set status = 'revoked', reviewed_at = now()
      where id = row.id;
    return jsonb_build_object('ok', true, 'status', 'revoked');
  end if;

  update public.devices
    set status = 'revoked', reviewed_at = now()
    where user_id = row.user_id and status = 'active';

  update public.devices
    set status = 'active', reviewed_at = now()
    where id = row.id;

  return jsonb_build_object('ok', true, 'status', 'active');
end;
$$;

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
  dur := least(7200, greatest(60, coalesce(p_duration, 300)));
  rad := least(200, greatest(15, coalesce(p_radius, 50)));

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

  insert into public.attendance (session_id, student_id, method, token_epoch)
  values (s.id, p_student_id, 'manual', floor(extract(epoch from now()) / 5)::bigint);

  return jsonb_build_object('ok', true, 'reason', 'marked');
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'reason', 'already');
end;
$$;

create or replace function public.remove_mark(p_session_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  owns boolean;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can remove a mark';
  end if;
  select exists(
    select 1 from public.sessions s
    where s.id = p_session_id and s.organiser_id = uid
  ) into owns;
  if not owns then
    raise exception 'This session belongs to another organiser';
  end if;

  delete from public.attendance
  where session_id = p_session_id and student_id = p_student_id;

  return jsonb_build_object('ok', true);
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

create or replace function public.sweep_sessions()
returns void
language sql
security definer
set search_path = public
as $$
  update public.sessions
  set status = 'closed'
  where status = 'live' and ends_at <= now();
$$;

revoke all on function public.device_hash(text) from public, anon, authenticated;
revoke all on function public.beacon_token(uuid, bigint) from public, anon, authenticated;
revoke all on function public.auto_confirm_email() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

revoke all on function public.register_device(text, text) from public, anon;
revoke all on function public.review_device(uuid, boolean) from public, anon;
revoke all on function public.start_session(text, text, integer, double precision, double precision, integer) from public, anon;
revoke all on function public.beacon_pulse(uuid) from public, anon;
revoke all on function public.auto_mark(text, uuid, text, double precision, double precision, integer, double precision) from public, anon;
revoke all on function public.manual_mark(uuid, uuid) from public, anon;
revoke all on function public.remove_mark(uuid, uuid) from public, anon;
revoke all on function public.close_session(uuid) from public, anon;
revoke all on function public.sweep_sessions() from public, anon;
revoke all on function public.haversine_m(double precision, double precision, double precision, double precision) from public, anon;

grant execute on function public.register_device(text, text) to authenticated;
grant execute on function public.review_device(uuid, boolean) to authenticated;
grant execute on function public.start_session(text, text, integer, double precision, double precision, integer) to authenticated;
grant execute on function public.beacon_pulse(uuid) to authenticated;
grant execute on function public.auto_mark(text, uuid, text, double precision, double precision, integer, double precision) to authenticated;
grant execute on function public.manual_mark(uuid, uuid) to authenticated;
grant execute on function public.remove_mark(uuid, uuid) to authenticated;
grant execute on function public.close_session(uuid) to authenticated;
grant execute on function public.sweep_sessions() to authenticated;

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.sessions enable row level security;
alter table public.attendance enable row level security;

revoke all on public.profiles from public, anon, authenticated;
revoke all on public.devices from public, anon, authenticated;
revoke all on public.sessions from public, anon, authenticated;
revoke all on public.attendance from public, anon, authenticated;

grant select (id, full_name, role, student_code, created_at) on public.profiles to authenticated;
grant select (id, user_id, label, status, created_at, reviewed_at) on public.devices to authenticated;
grant select (
  id, organiser_id, title, course, duration_seconds, started_at, ends_at,
  status, radius_meters, last_beacon_at, created_at
) on public.sessions to authenticated;
grant select (
  id, session_id, student_id, device_id, marked_at, rssi, distance_meters, method, token_epoch
) on public.attendance to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated using (true);

create policy devices_select on public.devices
  for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'organiser'
    )
  );

create policy sessions_select on public.sessions
  for select to authenticated using (true);

create policy attendance_select on public.attendance
  for select to authenticated using (
    student_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'organiser'
    )
  );

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.attendance;
    alter publication supabase_realtime add table public.sessions;
    alter publication supabase_realtime add table public.devices;
  end if;
end $$;

notify pgrst, 'reload schema';
