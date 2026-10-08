-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — AI-generation hint column (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHAT this is:
--  portfolio_items.ai_score stores Sightengine's free 'genai' verdict
--  (0 = likely human-made, 1 = likely AI-generated), written at upload by
--  the app (v82+) via the 'detect-ai' Edge Function. The professor review
--  panel shows it as an ADVISORY badge only — it never blocks uploads or
--  affects grades, because detectors can misflag real digital art.
--
--  The app is defensive: if you skip this file, uploads still work (the
--  insert is retried without the column). Run it to enable the badge.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — new uploads carry the score; older rows show "not checked".
-- ═══════════════════════════════════════════════════════════════════

alter table portfolio_items
  add column if not exists ai_score double precision;
