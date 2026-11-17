-- ═══════════════════════════════════════════════════════════
--  Artfolio — Domain-scoped unenrollment
--
--  - Multimedia (or Data Analytics) professors unenroll only
--    their OWN domain's students from their own section.
--  - Art Appreciation professors unenroll only students from
--    the Art Appreciation track (art_app_enrolled → false).
--  - Super admins can do all of the above.
--  - Direct professor writes to user_profiles.section are
--    locked to super admins (RPC below is the only other path).
-- ═══════════════════════════════════════════════════════════

-- ── Helper: is the caller MM/DA professor, same dept as student? ──
-- Used only inside unenroll_student() to enforce domain scoping.
create or replace function _is_mm_da_professor_for(p_student_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_own  text;
  v_them text;
begin
  select department into v_own
    from public.user_profiles
   where user_id = auth.uid() and role in ('professor','admin');
  if not found then
    return false;
  end if;
  if public.is_super_admin() then
    return true;
  end if;
  select department into v_them
    from public.user_profiles
   where user_id = p_student_id;
  -- Legacy null department is treated as MM.
  v_own  := coalesce(v_own,  'BS Information Technology Major in Multimedia Arts');
  v_them := coalesce(v_them, 'BS Information Technology Major in Multimedia Arts');
  return v_own = v_them;
end;
$$;

-- ── MM/DA unenrollment (clears the student's OWN-domain section) ──
drop function if exists unenroll_student(uuid);

create or replace function unenroll_student(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._is_full_professor() then
    raise exception 'Only professors can unenroll students.';
  end if;
  if not public._is_mm_da_professor_for(p_student_id) then
    raise exception 'You can only unenroll students in your own program.';
  end if;
  update public.user_profiles
     set section = null
   where user_id = p_student_id and role = 'student';
end;
$$;

-- ── Art Appreciation unenrollment (keeps the student's own section) ──
drop function if exists unenroll_art_app(uuid);

create or replace function unenroll_art_app(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._is_art_app_professor() then
    raise exception 'Only the Art Appreciation professor can unenroll students from Art Appreciation.';
  end if;
  update public.user_profiles
     set art_app_enrolled = false
   where user_id = p_student_id
     and role = 'student'
     and art_app_enrolled = true;
end;
$$;

-- ── Tighten direct row updates to super admins only ──
-- The section_requests / art_app_requests / enroll_* flows all go through
-- security-definer RPCs, so narrowing the blanket policy costs nothing.
drop policy if exists "full access updates student enrollment" on public.user_profiles;
create policy "super admin updates student enrollment"
  on public.user_profiles
  for update to authenticated
  using (public.is_super_admin() and role = 'student')
  with check (public.is_super_admin() and role = 'student');

grant execute on function _is_mm_da_professor_for(uuid) to authenticated;
grant execute on function unenroll_student(uuid) to authenticated;
grant execute on function unenroll_art_app(uuid) to authenticated;
