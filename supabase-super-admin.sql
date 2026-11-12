-- ═══════════════════════════════════════════════════════════
--  Artfolio — Super Admin + per-account full grading access
--  (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════
--  WHAT this adds:
--    1. user_profiles.is_super_admin  — the system owner flag
--    2. user_profiles.can_grade       — grant full grading power
--       to a specific professor (e.g. an Art Appreciation
--       teacher) without changing their department.
--    3. is_super_admin()              — server-side role check
--    4. _is_full_professor()          — now also honours can_grade
--    5. Privilege guard trigger       — students/professors can
--       never self-promote or change role/department/flags.
--    6. admin_audit_log               — append-only history of
--       every role / department / permission change.
--    7. RLS policies                  — super admin and full-access
--       professors work consistently across grading tables.
--    8. Account removal               — super admins can delete a
--       profile row from the panel (auth login is separate).
--
--  HOW TO INSTALL:
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Promote ONE account (edit the email first), then run:
--
--       update public.user_profiles
--          set is_super_admin = true,
--              can_grade      = true
--        where lower(email) = lower('your@asiatech.edu.ph');
--
--    4. Optional — give an Art Appreciation teacher full grading
--       access (either line works; the flag is enough):
--
--       update public.user_profiles
--          set can_grade = true
--        where lower(email) = lower('artapp.teacher@asiatech.edu.ph');
--
--       update public.user_profiles
--          set department = 'Art Appreciation'
--        where lower(email) = lower('artapp.teacher@asiatech.edu.ph');
--
--  Safe to re-run. The SQL Editor runs without an end-user JWT
--  (auth.uid() is null), so the guard allows provisioning there.
--
--  Also run supabase-lock-section.sql (if you haven't) so students
--  cannot clear or change their own section directly.
-- ═══════════════════════════════════════════════════════════

-- ── 1. Columns ──────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists is_super_admin boolean not null default false;

alter table public.user_profiles
  add column if not exists can_grade boolean not null default false;

-- ── 2. Helpers ──────────────────────────────────────────────
create or replace function public.is_super_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.user_profiles
     where user_id = auth.uid()
       and is_super_admin = true
       and role in ('professor', 'admin')
  );
$$;

-- Full grading access = Multimedia Arts major, Art Appreciation,
-- an explicitly granted can_grade flag, or a super admin.
create or replace function public._is_full_professor()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.user_profiles
     where user_id = auth.uid()
       and role in ('professor', 'admin')
       and (
         department in (
           'BS Information Technology Major in Multimedia Arts',
           'Art Appreciation'
         )
         or can_grade = true
         or is_super_admin = true
       )
  );
$$;

grant execute on function public.is_super_admin() to authenticated;
grant execute on function public._is_full_professor() to authenticated;
revoke execute on function public.is_super_admin() from anon;
revoke execute on function public._is_full_professor() from anon;

-- ── 3. Privilege guard ──────────────────────────────────────
-- Only a super admin may change role, department, can_grade or
-- is_super_admin. Self-demotion and removing the last super
-- admin are blocked. Section changes stay covered by
-- supabase-lock-section.sql.
create or replace function public.prevent_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Nothing privileged changed — normal profile/enrollment updates pass.
  if new.role          is not distinct from old.role
     and new.department is not distinct from old.department
     and new.can_grade  is not distinct from old.can_grade
     and new.is_super_admin is not distinct from old.is_super_admin then
    return new;
  end if;

  -- SQL Editor / service role: allow provisioning.
  if auth.uid() is null then
    return new;
  end if;

  -- Must be a super admin to touch these columns.
  if not public.is_super_admin() then
    raise exception 'Only a super admin can change roles, departments, or access flags.'
      using errcode = '42501';
  end if;

  -- A super admin cannot change their own role or access flags.
  if new.user_id = auth.uid()
     and (
       new.role is distinct from old.role
       or new.is_super_admin is distinct from old.is_super_admin
       or new.can_grade is distinct from old.can_grade
     ) then
    raise exception 'You cannot change your own role or access flags.'
      using errcode = '42501';
  end if;

  -- The super-admin flag only makes sense on professor/admin accounts.
  if new.is_super_admin = true and new.role not in ('professor', 'admin') then
    raise exception 'Super admin status requires a professor or admin role.'
      using errcode = '42501';
  end if;

  -- Never remove the last super admin.
  if old.is_super_admin = true and new.is_super_admin = false then
    if (select count(*) from public.user_profiles where is_super_admin = true) <= 1 then
      raise exception 'There must always be at least one super admin.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_privilege_columns on public.user_profiles;

create trigger guard_privilege_columns
  before update on public.user_profiles
  for each row
  execute function public.prevent_privilege_escalation();

-- ── 3b. Insert guard ───────────────────────────────────────
-- A new account can never be born as super admin or with full
-- grading access, even if someone posts those columns directly.
-- Supabase dashboard/SQL Editor (auth.uid() is null) and a real
-- super admin are still allowed to provision accounts.
create or replace function public.guard_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_super_admin() then
    new.is_super_admin := false;
    new.can_grade := false;
    if new.role not in ('student', 'professor') then
      new.role := 'student';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_privilege_insert on public.user_profiles;

create trigger guard_privilege_insert
  before insert on public.user_profiles
  for each row
  execute function public.guard_profile_insert();

-- ── 4. Audit log ────────────────────────────────────────────
create table if not exists public.admin_audit_log (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid,
  actor_name     text,
  action         text not null,
  target_user_id uuid,
  target_name    text,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

-- Read: super admins only. No insert/update/delete policies — rows are
-- written only by the SECURITY DEFINER trigger below, so the log is
-- append-only from the app's point of view.
drop policy if exists "super admin reads audit log" on public.admin_audit_log;
create policy "super admin reads audit log"
  on public.admin_audit_log
  for select to authenticated
  using (public.is_super_admin());

create or replace function public.log_privilege_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
begin
  select full_name into v_actor_name
    from public.user_profiles
   where user_id = auth.uid();

  insert into public.admin_audit_log (
    actor_id, actor_name, action, target_user_id, target_name, detail
  ) values (
    auth.uid(),
    v_actor_name,
    'profile_privileges_changed',
    new.user_id,
    new.full_name,
    jsonb_build_object(
      'old_role',          old.role,
      'new_role',          new.role,
      'old_department',    old.department,
      'new_department',    new.department,
      'old_can_grade',     old.can_grade,
      'new_can_grade',     new.can_grade,
      'old_super_admin',   old.is_super_admin,
      'new_super_admin',   new.is_super_admin
    )
  );

  return new;
end;
$$;

drop trigger if exists audit_privilege_change on public.user_profiles;

create trigger audit_privilege_change
  after update on public.user_profiles
  for each row
  when (
    new.role            is distinct from old.role
    or new.department   is distinct from old.department
    or new.can_grade    is distinct from old.can_grade
    or new.is_super_admin is distinct from old.is_super_admin
  )
  execute function public.log_privilege_change();

-- ── 5. RLS: super admin account management ──────────────────
drop policy if exists "super admin reads profiles" on public.user_profiles;
create policy "super admin reads profiles"
  on public.user_profiles
  for select to authenticated
  using (public.is_super_admin());

drop policy if exists "super admin updates profiles" on public.user_profiles;
create policy "super admin updates profiles"
  on public.user_profiles
  for update to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Super admin may remove a profile row from the panel. The auth login
-- (Authentication → Users) is intentionally NOT touched here — deleting
-- that requires the service-role key, which must stay off the client.
drop policy if exists "super admin deletes profiles" on public.user_profiles;
create policy "super admin deletes profiles"
  on public.user_profiles
  for delete to authenticated
  using (public.is_super_admin());

create or replace function public.guard_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Never allow the last super admin to be deleted, even from SQL Editor.
  if old.is_super_admin = true
     and (select count(*) from public.user_profiles where is_super_admin = true) <= 1 then
    raise exception 'There must always be at least one super admin.'
      using errcode = '42501';
  end if;

  -- SQL Editor / service role: allow provisioning cleanup.
  if auth.uid() is null then
    return old;
  end if;

  if old.user_id = auth.uid() then
    raise exception 'You cannot delete your own account.'
      using errcode = '42501';
  end if;

  if not public.is_super_admin() then
    raise exception 'Only a super admin can delete accounts.'
      using errcode = '42501';
  end if;

  return old;
end;
$$;

drop trigger if exists guard_profile_delete on public.user_profiles;
create trigger guard_profile_delete
  before delete on public.user_profiles
  for each row
  execute function public.guard_profile_delete();

create or replace function public.log_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
begin
  select full_name into v_actor_name
    from public.user_profiles
   where user_id = auth.uid();

  insert into public.admin_audit_log (
    actor_id, actor_name, action, target_user_id, target_name, detail
  ) values (
    auth.uid(),
    v_actor_name,
    'profile_deleted',
    old.user_id,
    old.full_name,
    jsonb_build_object(
      'role',         old.role,
      'department',   old.department,
      'can_grade',    old.can_grade,
      'super_admin',  old.is_super_admin
    )
  );

  return old;
end;
$$;

drop trigger if exists audit_profile_delete on public.user_profiles;
create trigger audit_profile_delete
  after delete on public.user_profiles
  for each row
  execute function public.log_profile_delete();

-- ── 6. RLS: full-access professors grade consistently ───────
-- These are additive permissive policies. They make can_grade and
-- Art Appreciation accounts work even if an older policy only
-- recognised the Multimedia Arts department string.
drop policy if exists "full access reads portfolios" on public.portfolios;
create policy "full access reads portfolios"
  on public.portfolios
  for select to authenticated
  using (public._is_full_professor());

drop policy if exists "full access updates portfolios" on public.portfolios;
create policy "full access updates portfolios"
  on public.portfolios
  for update to authenticated
  using (public._is_full_professor())
  with check (public._is_full_professor());

drop policy if exists "full access reads items" on public.portfolio_items;
create policy "full access reads items"
  on public.portfolio_items
  for select to authenticated
  using (public._is_full_professor());

drop policy if exists "full access updates items" on public.portfolio_items;
create policy "full access updates items"
  on public.portfolio_items
  for update to authenticated
  using (public._is_full_professor())
  with check (public._is_full_professor());

drop policy if exists "full access deletes items" on public.portfolio_items;
create policy "full access deletes items"
  on public.portfolio_items
  for delete to authenticated
  using (public._is_full_professor());

drop policy if exists "full access deletes portfolios" on public.portfolios;
create policy "full access deletes portfolios"
  on public.portfolios
  for delete to authenticated
  using (public._is_full_professor());

drop policy if exists "full access reads feedback" on public.feedback;
create policy "full access reads feedback"
  on public.feedback
  for select to authenticated
  using (public._is_full_professor());

drop policy if exists "full access writes feedback" on public.feedback;
create policy "full access writes feedback"
  on public.feedback
  for insert to authenticated
  with check (public._is_full_professor());

drop policy if exists "full access reads assignments" on public.assignments;
create policy "full access reads assignments"
  on public.assignments
  for select to authenticated
  using (public._is_full_professor());

drop policy if exists "full access creates assignments" on public.assignments;
create policy "full access creates assignments"
  on public.assignments
  for insert to authenticated
  with check (public._is_full_professor());

drop policy if exists "full access updates assignments" on public.assignments;
create policy "full access updates assignments"
  on public.assignments
  for update to authenticated
  using (public._is_full_professor())
  with check (public._is_full_professor());

drop policy if exists "full access deletes assignments" on public.assignments;
create policy "full access deletes assignments"
  on public.assignments
  for delete to authenticated
  using (public._is_full_professor());

drop policy if exists "full access manages sections" on public.sections;
create policy "full access manages sections"
  on public.sections
  for all to authenticated
  using (public._is_full_professor())
  with check (public._is_full_professor());

drop policy if exists "full access manages subjects" on public.subjects;
create policy "full access manages subjects"
  on public.subjects
  for all to authenticated
  using (public._is_full_professor())
  with check (public._is_full_professor());

drop policy if exists "full access reads similarity logs" on public.similarity_logs;
create policy "full access reads similarity logs"
  on public.similarity_logs
  for select to authenticated
  using (public._is_full_professor());

drop policy if exists "full access deletes similarity logs" on public.similarity_logs;
create policy "full access deletes similarity logs"
  on public.similarity_logs
  for delete to authenticated
  using (public._is_full_professor());

notify pgrst, 'reload schema';
