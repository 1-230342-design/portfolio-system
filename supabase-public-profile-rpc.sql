-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — public profile works RPC (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHY this exists:
--  The public portfolio page must show public works to EVERYONE
--  (logged-out visitors, students, professors alike): approved works plus
--  personal-gallery pieces the student chose to publish. Direct table reads go
--  through RLS, which is role-scoped — e.g. an owner-only policy on
--  portfolios hides other students' approved works from logged-in
--  professors, showing a false "no approved works" empty state. This
--  SECURITY DEFINER function bypasses RLS but returns ONLY public-safe
--  columns (never emails or comments), so the page is correct for every
--  caller without opening the tables up.
--
--  GRADES ARE OPT-IN:
--  final_grade is returned ONLY when the student turned on "Show my grades on
--  my public portfolio" (user_profiles.show_grades_public, default false).
--  Everyone else gets null, so the public page can never leak a score the
--  student didn't choose to publish. This file adds that column if missing.
--
--  The app (v90+) calls this first and falls back to direct queries only
--  when the function doesn't exist yet — so old deploys keep working.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — public profiles immediately show approved + personal public
--       works for every role. Verify with: select get_public_profile_works('<any-user-id>');
-- ═══════════════════════════════════════════════════════════════════

-- Per-student opt-in for showing grades on the public portfolio.
alter table user_profiles
  add column if not exists show_grades_public boolean not null default false;

create or replace function get_public_profile_works(p_student_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approved int;
  v_works json;
begin
  select count(*)
    into v_approved
    from portfolios
   where student_id = p_student_id
     and status = 'approved';

  select coalesce(json_agg(row_to_json(w) order by w.uploaded_at desc nulls last), '[]'::json)
    into v_works
    from (
      select i.id          as item_id,
             i.portfolio_id,
             i.title,
             i.description,
             i.file_url,
             i.file_type,
             s.name        as subject_name,
             s.code        as subject_code,
             i.uploaded_at,
             -- Null unless the student opted in — the client never has to
             -- decide whether it's allowed to show a grade.
             case when coalesce(up.show_grades_public, false)
                  then p.final_grade else null end as final_grade
        from portfolio_items i
        join portfolios p on p.id = i.portfolio_id
        left join subjects s on s.id = p.subject_id
        left join user_profiles up on up.user_id = p.student_id
       where p.student_id = p_student_id
         and (p.status = 'approved' or (p.status = 'draft' and p.submitted_at is null))
         and i.is_public = true
    ) w;

  return json_build_object('approved_count', v_approved, 'works', v_works);
end
$$;

grant execute on function get_public_profile_works(uuid) to anon, authenticated;
