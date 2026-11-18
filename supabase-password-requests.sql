-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — Password reset requests (student asks, super admin decides)
-- ═══════════════════════════════════════════════════════════════════

create table if not exists password_reset_requests (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid,
  note         text
);

create index if not exists password_reset_requests_student_idx on password_reset_requests (student_id);
create index if not exists password_reset_requests_status_idx  on password_reset_requests (status);

alter table password_reset_requests enable row level security;
-- Intentionally zero policies: functions only.

-- ── Helper: is the caller a super admin? ──
create or replace function public._is_pw_admin()
returns boolean
language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles
     where user_id = auth.uid()
       and role in ('professor', 'admin')
       and is_super_admin = true
  );
$$;

-- ── Student files a password reset request ──
drop function if exists request_password_reset();

create or replace function request_password_reset()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;
  -- Only students may ask
  if not exists (select 1 from public.user_profiles
                  where user_id = auth.uid() and role = 'student') then
    raise exception 'Only student accounts can request a password reset.';
  end if;
  if exists (select 1 from password_reset_requests
              where student_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a pending password reset request.';
  end if;
  insert into password_reset_requests (student_id) values (auth.uid())
  returning id into v_id;
  return v_id;
end
$$;

-- ── Student's own requests ──
drop function if exists my_password_reset_requests();

create or replace function my_password_reset_requests()
returns table(
  id          uuid,
  status      text,
  created_at  timestamptz,
  decided_at  timestamptz,
  note        text
)
language sql security definer set search_path = public
as $$
  select id, status, created_at, decided_at, note
    from password_reset_requests
   where student_id = auth.uid()
   order by created_at desc
   limit 20;
$$;

-- ── Super admin inbox: PENDING ONLY ──
drop function if exists list_password_reset_requests();

create or replace function list_password_reset_requests()
returns table(
  id             uuid,
  student_id     uuid,
  student_name   text,
  student_number text,
  section        text,
  created_at     timestamptz
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public._is_pw_admin() then
    raise exception 'Only super admins can view password reset requests.';
  end if;
  return query
    select r.id, r.student_id,
           coalesce(p.full_name, 'Student'),
           coalesce(p.student_id, ''),
           coalesce(p.section, ''),
           r.created_at
      from password_reset_requests r
      left join user_profiles p on p.user_id = r.student_id
     where r.status = 'pending'
     order by r.created_at desc
     limit 50;
end
$$;

-- ── Super admin decides: APPROVE (sets new password) / DECLINE ──
-- On approval, sets the encrypted password in auth.users with pgcrypto.
drop function if exists decide_password_reset_request(uuid, boolean, text);

create or replace function decide_password_reset_request(
  p_id        uuid,
  p_approve   boolean,
  p_new_pw    text default null
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  r password_reset_requests%rowtype;
begin
  if not public._is_pw_admin() then
    raise exception 'Only super admins can decide password reset requests.';
  end if;
  select * into r from password_reset_requests where id = p_id;
  if not found then raise exception 'Request not found.'; end if;
  if r.status <> 'pending' then raise exception 'Already decided.'; end if;

  if p_approve then
    if p_new_pw is null or length(p_new_pw) < 6 then
      raise exception 'New password must be at least 6 characters.';
    end if;
    update auth.users
       set encrypted_password = crypt(p_new_pw, gen_salt('bf')),
           updated_at          = now()
     where id = r.student_id;
    update password_reset_requests
       set status = 'approved', decided_at = now(), decided_by = auth.uid()
     where id = p_id;
    return 'approved';
  else
    update password_reset_requests
       set status = 'rejected', decided_at = now(), decided_by = auth.uid()
     where id = p_id;
    return 'rejected';
  end if;
end
$$;

-- ── Student cancels own pending request ──
create or replace function cancel_password_reset_request(p_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update password_reset_requests
     set status = 'cancelled'
   where id = p_id
     and student_id = auth.uid()
     and status = 'pending';
$$;

-- ── grants ──
grant execute on function _is_pw_admin() to authenticated;
grant execute on function request_password_reset() to authenticated;
grant execute on function my_password_reset_requests() to authenticated;
grant execute on function list_password_reset_requests() to authenticated;
grant execute on function decide_password_reset_request(uuid, boolean, text) to authenticated;
grant execute on function cancel_password_reset_request(uuid) to authenticated;
