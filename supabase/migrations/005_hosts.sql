create table if not exists public.session_hosts (
  session_id uuid not null references public.sessions (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (session_id, profile_id)
);

alter table public.session_hosts enable row level security;

drop policy if exists session_hosts_select on public.session_hosts;
create policy session_hosts_select on public.session_hosts
  for select to authenticated using (true);

grant select (session_id, profile_id, joined_at) on public.session_hosts to authenticated;

create or replace function public.session_host(p_session_id uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sessions s
    where s.id = p_session_id
      and (
        s.organiser_id = p_user
        or exists (
          select 1 from public.session_hosts h
          where h.session_id = s.id and h.profile_id = p_user
        )
      )
  );
$$;

create or replace function public.join_as_host(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  role text;
  s public.sessions;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can co-host a class';
  end if;
  select * into s from public.sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found';
  end if;
  if s.status <> 'live' or s.ends_at <= now() then
    raise exception 'This class is no longer live';
  end if;
  if s.organiser_id = uid then
    return jsonb_build_object('ok', true, 'reason', 'owner');
  end if;
  insert into public.session_hosts (session_id, profile_id)
  values (s.id, uid)
  on conflict (session_id, profile_id) do nothing;
  return jsonb_build_object('ok', true, 'reason', 'host');
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
  if not public.session_host(s.id, uid) then
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

create or replace function public.mark_absent(p_session_id uuid, p_student_id uuid)
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
    raise exception 'Only an organiser can mark someone absent';
  end if;
  select * into s from public.sessions where id = p_session_id;
  if not found then
    raise exception 'Session not found';
  end if;
  if not public.session_host(s.id, uid) then
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
  set presence = 'absent',
      absent_at = now(),
      grace_until = null,
      method = 'manual'
  where session_id = s.id and student_id = p_student_id;

  if found then
    return jsonb_build_object('ok', true, 'reason', 'absent');
  end if;

  insert into public.attendance (session_id, student_id, method, token_epoch, presence, absent_at)
  values (s.id, p_student_id, 'manual', floor(extract(epoch from now()) / 5)::bigint, 'absent', now());

  return jsonb_build_object('ok', true, 'reason', 'absent');
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
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select p.role into role from public.profiles p where p.id = uid;
  if role is distinct from 'organiser' then
    raise exception 'Only an organiser can remove a mark';
  end if;
  if not public.session_host(p_session_id, uid) then
    raise exception 'This session belongs to another organiser';
  end if;

  delete from public.attendance
  where session_id = p_session_id and student_id = p_student_id;

  return jsonb_build_object('ok', true);
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
  epoch bigint;
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
    if p_rssi is not null
      and p_rssi < -70
      and p_rssi > -127
      and public.token_matches(s.id, p_token) then
      epoch := floor(extract(epoch from now()) / 5)::bigint;
      insert into public.attendance (
        session_id, student_id, device_id, rssi, method, token_epoch, presence, last_seen_at, grace_until
      ) values (
        s.id, uid, dev.id, p_rssi, 'auto', epoch, 'grace', now(), now() + interval '30 seconds'
      );
      return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', 30, 'session_id', s.id, 'rssi', p_rssi);
    end if;
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
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'reason', 'grace', 'seconds', 30, 'session_id', s.id);
end;
$$;

revoke all on function public.session_host(uuid, uuid) from public, anon, authenticated;
revoke all on function public.join_as_host(uuid) from public, anon;
revoke all on function public.mark_absent(uuid, uuid) from public, anon;
grant execute on function public.join_as_host(uuid) to authenticated;
grant execute on function public.mark_absent(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
