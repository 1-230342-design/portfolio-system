-- ═══════════════════════════════════════════════════════════
--  Artfolio — single public work RPC (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════
--  WHAT this is for:
--  The QR destination page (?work=<id>) must show a work to
--  logged-out visitors. Direct reads fail here: anon can read
--  portfolio_items where is_public = true, but CANNOT read the
--  parent portfolios row for personal-gallery drafts (owner-only
--  RLS) — so the current direct-query check wrongly reports
--  "This work isn't available" for personal public works like
--  the Purrfect Brew LOGO. This SECURITY DEFINER function checks
--  status server-side and returns the work only when it is
--  approved OR a personal draft (never submitted), exactly like
--  get_recent_public_works / get_public_profile_works.
--
--  The app tries this first and falls back to direct queries when
--  the function doesn't exist yet — run this before the defense
--  so QR scans work for every public work.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — verify with:
--       select * from get_public_work('<any-public-item-id>');
-- ═══════════════════════════════════════════════════════════

create or replace function get_public_work(p_item_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item json;
begin
  select row_to_json(w) into v_item
    from (
      select
        i.id as item_id,
        i.portfolio_id,
        i.title,
        i.description,
        i.file_url,
        i.file_type,
        i.uploaded_at,
        p.status as portfolio_status,
        p.submitted_at,
        pr.full_name as student_name,
        pr.section as section,
        pr.year_level as year_level,
        pr.social_link as social_link,
        coalesce(pr.show_social_on_qr, false) as show_social_on_qr,
        case when coalesce(pr.show_grades_public, false) then p.final_grade else null end as final_grade
      from portfolio_items i
      join portfolios p on p.id = i.portfolio_id
      left join user_profiles pr on pr.user_id = p.student_id
     where i.id = p_item_id
       and i.is_public = true
       and (p.status = 'approved' or (p.status = 'draft' and p.submitted_at is null))
    ) w;
  return v_item;
end;
$$;

grant execute on function get_public_work(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
