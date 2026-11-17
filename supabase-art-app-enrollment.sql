-- ═══════════════════════════════════════════════════════════
--  Artfolio — Art Appreciation enrollment (column + backfill only)
--  Approve flow lives in supabase-art-app-requests.sql
--  (request_art_app_enrollment / my_art_app_requests /
--   list_art_app_requests / decide_art_app_request /
--   cancel_art_app_request)
-- ═══════════════════════════════════════════════════════════

-- ── 1. Column ─────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists art_app_enrolled boolean not null default false;

-- ── 2. Backfill: every existing Data Analytics student ─────
update public.user_profiles
   set art_app_enrolled = true
 where role = 'student'
   and department = 'BS Information Technology Major in Data Analytics';
