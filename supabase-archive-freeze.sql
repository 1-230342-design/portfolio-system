-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — Grade Archive freeze lock (one-time setup)
-- ═══════════════════════════════════════════════════════════════════
--  WHAT this is for:
--  Grade Archives previews live data, so re-saving a grade silently rewrites
--  what the "archive" shows. The 🔒 Freeze button in Grade Archives records
--  a lock per section + grading period here, and saveGrade() refuses to
--  overwrite grades in a frozen period until a professor unfreezes it.
--
--  HOW TO INSTALL (once, ~1 minute):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — no code changes needed. Until this is run, the Freeze button
--       shows a "not set up yet" message and grading works exactly as before
--       (the lock fails open, never blocks a legit grade save).
-- ═══════════════════════════════════════════════════════════════════

create table if not exists archive_freezes (
  id             uuid primary key default gen_random_uuid(),
  section_name   text not null,
  grading_period text not null,
  school_year    text,
  semester       text,
  frozen_at      timestamptz not null default now(),
  frozen_by      uuid,
  unique (section_name, grading_period)
);

alter table archive_freezes enable row level security;

-- Professors manage freezes from the app (the buttons only exist on the
-- professor Grade Archives page). These policies let any logged-in user read
-- or change freeze rows; students never see the buttons, so in practice only
-- professors touch them.
drop policy if exists "freeze read"   on archive_freezes;
drop policy if exists "freeze write"  on archive_freezes;
drop policy if exists "freeze delete" on archive_freezes;

create policy "freeze read"   on archive_freezes for select to authenticated using (true);
create policy "freeze write"  on archive_freezes for insert to authenticated with check (true);
create policy "freeze delete" on archive_freezes for delete to authenticated using (true);
