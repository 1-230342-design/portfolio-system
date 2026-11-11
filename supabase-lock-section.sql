-- ═══════════════════════════════════════════════════════════
--  Artfolio — lock section/enrollment changes to professors
--  (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════
--  WHAT this is for:
--  The app no longer shows students an "Unenroll from section"
--  button, and Edit Profile never writes section/year_level.
--  This trigger makes that rule hold at the DATABASE too: a
--  student account cannot clear or change its own section with
--  a hand-crafted API call, while professors/admins still can
--  place, move, or remove a student (Students page).
--
--  Safe to run more than once. Students editing their name,
--  avatar, skills, etc. are unaffected — the trigger only fires
--  when the section value actually changes. The SQL Editor and
--  service role (auth.uid() is null) are allowed.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done.
-- ═══════════════════════════════════════════════════════════

create or replace function public.prevent_student_section_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Nothing to enforce when the section is unchanged (or only '' vs null).
  if coalesce(new.section, '') = coalesce(old.section, '') then
    return new;
  end if;

  -- SQL Editor / service role: no end-user JWT, allow.
  if auth.uid() is null then
    return new;
  end if;

  -- Professors and admins may enroll, move, or unenroll students.
  if exists (
    select 1
      from public.user_profiles p
     where p.user_id = auth.uid()
       and p.role in ('professor', 'admin')
  ) then
    return new;
  end if;

  -- Any other end user (i.e. a student) may not touch section.
  raise exception 'Only a professor can change a student''s section.'
    using errcode = '42501';
end;
$$;

drop trigger if exists lock_student_section on public.user_profiles;

create trigger lock_student_section
  before update on public.user_profiles
  for each row
  execute function public.prevent_student_section_change();

notify pgrst, 'reload schema';
