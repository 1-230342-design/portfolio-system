-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — section transfer requests (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHAT this is for:
--  Changing sections (when already enrolled) files a TRANSFER REQUEST instead
--  of switching instantly. Professors approve/decline from the Students page;
--  students get decision cards in Notifications. First-time picks (signup,
--  unenrolled → section) stay instant and never touch this table.
--
--  SECURITY design (same pattern as the OTP + similarity helpers):
--  The table has NO direct-access policies — nobody can read or write it
--  through the API. All access goes through the four SECURITY DEFINER
--  functions below. Professor-only functions re-check the caller's role
--  inside the database, so reviewer-only accounts and students are rejected
--  server-side no matter what the UI shows.
--
--  HOW TO INSTALL (once, ~1 minute):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — until this is run, section changes behave exactly as before
--       (instant), and the transfer UI explains itself.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists section_requests (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null,
  from_section text,
  to_section   text not null,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid
);

create index if not exists section_requests_student_idx on section_requests (student_id);
create index if not exists section_requests_status_idx on section_requests (status);

alter table section_requests enable row level security;
-- Intentionally zero policies: functions only.

-- ── helper: is the caller a full professor? ──
create or replace function _is_professor()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_profiles
     where user_id = auth.uid()
       and role in ('professor', 'admin')
  );
$$;

-- ── student files a transfer (their current section is snapshotted) ──
drop function if exists file_section_request(text);

create or replace function file_section_request(p_to_section text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from text;
  v_id   uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;
  if p_to_section is null or btrim(p_to_section) = '' then
    raise exception 'Pick a section first.';
  end if;

  select section into v_from from user_profiles where user_id = auth.uid();
  -- Unenrolled students (NULL/blank section) file join requests too — every
  -- section acquisition needs a professor's yes; only signup picks are direct.
  if v_from is not null and btrim(v_from) <> '' and btrim(p_to_section) = btrim(v_from) then
    raise exception 'You are already in that section.';
  end if;
  if exists (select 1 from section_requests
              where student_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a pending transfer request.';
  end if;

  insert into section_requests (student_id, from_section, to_section)
  values (auth.uid(), v_from, btrim(p_to_section))
  returning id into v_id;
  return v_id;
end
$$;

-- ── student's own requests (pending note, cancel button, notifications) ──
drop function if exists my_section_requests();

create or replace function my_section_requests()
returns table(
  id           uuid,
  from_section text,
  to_section   text,
  status       text,
  created_at   timestamptz,
  decided_at   timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, from_section, to_section, status, created_at, decided_at
    from section_requests
   where student_id = auth.uid()
   order by created_at desc
   limit 20;
$$;

-- ── professor inbox: PENDING ONLY. Decided requests vanish the moment
-- they're approved/declined (students are told via Notifications instead),
-- so the inbox is always a pure to-do list, never history. ──
drop function if exists list_section_requests();

create or replace function list_section_requests()
returns table(
  id             uuid,
  student_id     uuid,
  student_name   text,
  student_number text,
  from_section   text,
  to_section     text,
  status         text,
  created_at     timestamptz,
  decided_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _is_professor() then
    raise exception 'Only professors can view transfer requests.';
  end if;
  return query
    select r.id, r.student_id,
           coalesce(p.full_name, 'Student'),
           coalesce(p.student_id, ''),
           r.from_section, r.to_section, r.status, r.created_at, r.decided_at
      from section_requests r
      left join user_profiles p on p.user_id = r.student_id
     where r.status = 'pending'
     order by r.created_at desc
     limit 50;
end
$$;

-- ── professor decides; approval flips the student's section ──
drop function if exists decide_section_request(uuid, boolean);

create or replace function decide_section_request(p_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r section_requests%rowtype;
begin
  if not _is_professor() then
    raise exception 'Only professors can decide transfer requests.';
  end if;

  select * into r from section_requests where id = p_id;
  if not found then
    raise exception 'Request not found.';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request was already decided.';
  end if;

  if p_approve then
    update user_profiles set section = r.to_section where user_id = r.student_id;
    update section_requests
       set status = 'approved', decided_at = now(), decided_by = auth.uid()
     where id = p_id;
    return 'approved';
  else
    update section_requests
       set status = 'rejected', decided_at = now(), decided_by = auth.uid()
     where id = p_id;
    return 'rejected';
  end if;
end
$$;

-- ── student cancels their own pending request ──
drop function if exists cancel_section_request(uuid);

create or replace function cancel_section_request(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update section_requests
     set status = 'cancelled'
   where id = p_id
     and student_id = auth.uid()
     and status = 'pending';
$$;

grant execute on function _is_professor() to authenticated;
grant execute on function file_section_request(text) to authenticated;
grant execute on function my_section_requests() to authenticated;
grant execute on function list_section_requests() to authenticated;
grant execute on function decide_section_request(uuid, boolean) to authenticated;
grant execute on function cancel_section_request(uuid) to authenticated;
