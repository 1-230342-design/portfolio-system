-- ═══════════════════════════════════════════════════════════
--  Artfolio — Art Appreciation enrollment requests
--  (pending-approval flow, mirrors section transfer requests)
-- ═══════════════════════════════════════════════════════════
--  WHAT this is for:
--  A Multimedia student taps "Enroll in Art Appreciation" and a
--  PENDING REQUEST is filed instead of instant enrollment. The
--  Art Appreciation professor approves or declines from the
--  "Art App Requests" sidebar page; approval flips
--  user_profiles.art_app_enrolled to true.
--
--  SECURITY design (same as the section-transfer flow):
--  No direct-access policies — nobody reads/writes the table via
--  the API. Everything goes through these SECURITY DEFINER functions.
--  Professor-only functions re-check the caller's Art Appreciation
--  department + role (or super admin) inside the database.
-- ═══════════════════════════════════════════════════════════

create table if not exists art_app_requests (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid
);

create index if not exists art_app_requests_student_idx on art_app_requests (student_id);
create index if not exists art_app_requests_status_idx  on art_app_requests (status);

alter table art_app_requests enable row level security;
-- Intentionally zero policies: functions only.

-- ── helper: caller is an Art Appreciation professor (or super admin)? ──
create or replace function _is_art_app_professor()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_profiles
     where user_id = auth.uid()
       and role in ('professor', 'admin')
       and (
         is_super_admin = true
         or department in ('Art Appreciation',
                           'BS Information Technology (Art Appreciation prof)')
       )
  );
$$;

-- ── student files an enrollment request ──
drop function if exists request_art_app_enrollment();

create or replace function request_art_app_enrollment()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrolled boolean;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;
  select art_app_enrolled into v_enrolled
    from user_profiles
   where user_id = auth.uid() and role = 'student';
  if not found then
    raise exception 'Only student accounts can enroll in Art Appreciation.';
  end if;
  if v_enrolled then
    raise exception 'You are already enrolled in Art Appreciation.';
  end if;
  if exists (select 1 from art_app_requests
              where student_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a pending Art Appreciation request.';
  end if;
  insert into art_app_requests (student_id) values (auth.uid())
  returning id into v_id;
  return v_id;
end
$$;

-- ── student's own requests (pending note, cancel button, notifications) ──
drop function if exists my_art_app_requests();

create or replace function my_art_app_requests()
returns table(
  id          uuid,
  status      text,
  created_at  timestamptz,
  decided_at  timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, status, created_at, decided_at
    from art_app_requests
   where student_id = auth.uid()
   order by created_at desc
   limit 20;
$$;

-- ── professor inbox: PENDING ONLY; decided requests vanish from the list ──
drop function if exists list_art_app_requests();

create or replace function list_art_app_requests()
returns table(
  id             uuid,
  student_id     uuid,
  student_name   text,
  student_number text,
  section        text,
  created_at     timestamptz,
  decided_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _is_art_app_professor() then
    raise exception 'Only the Art Appreciation professor can view these requests.';
  end if;
  return query
    select r.id, r.student_id,
           coalesce(p.full_name, 'Student'),
           coalesce(p.student_id, ''),
           coalesce(p.section, ''),
           r.created_at, r.decided_at
      from art_app_requests r
      left join user_profiles p on p.user_id = r.student_id
     where r.status = 'pending'
     order by r.created_at desc
     limit 50;
end
$$;

-- ── professor decides; approval enrolls the student ──
drop function if exists decide_art_app_request(uuid, boolean);

create or replace function decide_art_app_request(p_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r art_app_requests%rowtype;
begin
  if not _is_art_app_professor() then
    raise exception 'Only the Art Appreciation professor can decide these requests.';
  end if;

  select * into r from art_app_requests where id = p_id;
  if not found then
    raise exception 'Request not found.';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request was already decided.';
  end if;

  if p_approve then
    update user_profiles
       set art_app_enrolled = true
     where user_id = r.student_id;
    update art_app_requests
       set status = 'approved', decided_at = now(), decided_by = auth.uid()
     where id = p_id;
    return 'approved';
  else
    update art_app_requests
       set status = 'rejected', decided_at = now(), decided_by = auth.uid()
     where id = p_id;
    return 'rejected';
  end if;
end
$$;

-- ── student cancels their own pending request ──
create or replace function cancel_art_app_request(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update art_app_requests
     set status = 'cancelled'
   where id = p_id
     and student_id = auth.uid()
     and status = 'pending';
$$;

-- ── grants ──
grant execute on function _is_art_app_professor() to authenticated;
grant execute on function request_art_app_enrollment() to authenticated;
grant execute on function my_art_app_requests() to authenticated;
grant execute on function list_art_app_requests() to authenticated;
grant execute on function decide_art_app_request(uuid, boolean) to authenticated;
grant execute on function cancel_art_app_request(uuid) to authenticated;
