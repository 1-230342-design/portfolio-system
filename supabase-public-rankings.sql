-- ═══════════════════════════════════════════════════════════
--  Artfolio — public rankings RPC (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════
--  WHAT this is for:
--  The logged-out "Top Overall Students" board (🏆 Rankings in the
--  public header) must rank by AVERAGE GRADE — the same number the
--  professor's Overall Rankings uses — so the two boards agree on
--  who is #1. Direct reads of portfolios.final_grade are blocked
--  for anonymous visitors by RLS, so this SECURITY DEFINER function
--  computes the board server-side and returns only public-safe
--  columns (name, section, average, count — never email).
--
--  PRIVACY (opt-in): only students who turned on "Show my grades on
--  my public portfolio" (user_profiles.show_grades_public) appear.
--  Everyone else is excluded, exactly like get_public_profile_works
--  hides their grades. The client masks student numbers itself.
--
--  The app calls this first and falls back to a works-count board
--  when the function doesn't exist yet — so run this before the
--  defense if you want the grade-based board live.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — verify with: select * from get_public_rankings();
-- ═══════════════════════════════════════════════════════════

create or replace function get_public_rankings()
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(row_to_json(w) order by w.avg_grade desc, w.graded_count desc), '[]'::json)
    from (
      select
        p.student_id as user_id,
        pr.full_name as full_name,
        pr.student_id as student_number,
        pr.section as section,
        pr.year_level as year_level,
        pr.avatar_url as avatar_url,
        round(avg(p.final_grade)::numeric, 1) as avg_grade,
        count(p.final_grade) as graded_count
      from portfolios p
      join user_profiles pr on pr.user_id = p.student_id
     where p.final_grade is not null
       and coalesce(pr.show_grades_public, false) = true
       and pr.role = 'student'
     group by p.student_id, pr.full_name, pr.student_id, pr.section, pr.year_level, pr.avatar_url
     order by avg(p.final_grade) desc, count(p.final_grade) desc
     limit 50
    ) w;
$$;

grant execute on function get_public_rankings() to anon, authenticated;

notify pgrst, 'reload schema';
