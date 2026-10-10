-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — public profile works RPC (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHY this exists:
--  The public portfolio page must show approved + public works to EVERYONE
--  (logged-out visitors, students, professors alike). Direct table reads go
--  through RLS, which is role-scoped — e.g. an owner-only policy on
--  portfolios hides other students' approved works from logged-in
--  professors, showing a false "no approved works" empty state. This
--  SECURITY DEFINER function bypasses RLS but returns ONLY public-safe
--  columns (never emails, grades, or comments), so the page is correct for
--  every caller without opening the tables up.
--
--  The app (v90+) calls this first and falls back to direct queries only
--  when the function doesn't exist yet — so old deploys keep working.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — public profiles immediately show approved public works for
--       every role. Verify with: select get_public_profile_works('<any-user-id>');
-- ═══════════════════════════════════════════════════════════════════

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
             i.uploaded_at
        from portfolio_items i
        join portfolios p on p.id = i.portfolio_id
        left join subjects s on s.id = p.subject_id
       where p.student_id = p_student_id
         and p.status = 'approved'
         and i.is_public = true
    ) w;

  return json_build_object('approved_count', v_approved, 'works', v_works);
end
$$;

grant execute on function get_public_profile_works(uuid) to anon, authenticated;
