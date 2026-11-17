-- ═══════════════════════════════════════════════════════════
--  Artfolio — Art Appreciation enrollment (multi-subject support)
--
--  A Multimedia student can enroll in Art Appreciation as an
--  extra subject (same section name). Data Analytics students
--  are enrolled automatically.
--
--  Adds:
--    1. user_profiles.art_app_enrolled boolean (default false)
--    2. Backfill: every existing Data Analytics student is true
--    3. enroll_in_art_app() — security-definer RPC the student
--       calls from Classwork. Students may only flip their own
--       flag, and only MM-style accounts (role student) qualify.
-- ═══════════════════════════════════════════════════════════

-- ── 1. Column ─────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists art_app_enrolled boolean not null default false;

-- ── 2. Backfill ───────────────────────────────────────────
update public.user_profiles
   set art_app_enrolled = true
 where role = 'student'
   and department = 'BS Information Technology Major in Data Analytics';

-- ── 3. Student-facing enroll RPC ──────────────────────────
-- Only the caller can flip their OWN flag, only students qualify.
create or replace function public.enroll_in_art_app()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Only a signed-in student can enroll in Art Appreciation.'
      using errcode = '42501';
  end if;
  update public.user_profiles
     set art_app_enrolled = true
   where user_id = auth.uid()
     and role = 'student';
end;
$$;

grant execute on function public.enroll_in_art_app() to authenticated;
revoke execute on function public.enroll_in_art_app() from anon;
