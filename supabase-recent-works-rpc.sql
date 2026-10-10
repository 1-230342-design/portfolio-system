-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — recent public works RPC (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHY this exists (same story as supabase-public-profile-rpc.sql):
--  The landing "Explore creative works" grid and hero mosaic must show
--  approved + public works to EVERYONE. Direct table reads go through
--  role-scoped RLS, which can hide other students' approved rows from
--  logged-in non-owners and fake an empty grid. This SECURITY DEFINER
--  function bypasses RLS but returns ONLY public-safe columns (titles,
--  files, names — never emails, grades, or comments).
--
--  The app (v92+) calls this first and falls back to direct queries only
--  when the function doesn't exist yet.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — verify with: select get_recent_public_works(5);
-- ═══════════════════════════════════════════════════════════════════

create or replace function get_recent_public_works(p_limit int)
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(row_to_json(w) order by w.uploaded_at desc nulls last), '[]'::json)
    from (
      select i.id,
             i.title,
             i.file_url,
             i.file_type,
             i.portfolio_id,
             i.uploaded_at,
             p.student_id,
             s.name as subject_name,
             s.code as subject_code,
             pr.full_name as student_name
        from portfolio_items i
        join portfolios p on p.id = i.portfolio_id
        left join subjects s on s.id = p.subject_id
        left join user_profiles pr on pr.user_id = p.student_id
       where i.is_public = true
         and p.status = 'approved'
       order by i.uploaded_at desc nulls last
       limit greatest(coalesce(p_limit, 24), 1)
    ) w;
$$;

grant execute on function get_recent_public_works(int) to anon, authenticated;
