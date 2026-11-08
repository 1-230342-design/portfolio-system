-- ═══════════════════════════════════════════════════════════
--  Artfolio — who rated this work (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════
--  WHAT this is for:
--  portfolios.rating is a single 1-5 value — the LAST professor to
--  rate a work wins. The student preview + notifications should
--  say WHO gave it ("Rating: ★★★★☆ (4/5) by Prof. Name"), for
--  every professor (Multimedia Arts graders AND reviewer-only
--  raters alike). This column records that professor's user_id.
--  Comments already carry attribution via feedback.professor_id;
--  this fills the same gap for the star rating itself.
--
--  The app falls back to the latest feedback row's professor when
--  this column is null (older ratings), so the UI works before
--  this is run — but run it so new ratings are attributed exactly.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — verify with: select rating, rating_by from portfolios limit 5;
-- ═══════════════════════════════════════════════════════════

alter table portfolios
  add column if not exists rating_by uuid;

notify pgrst, 'reload schema';
