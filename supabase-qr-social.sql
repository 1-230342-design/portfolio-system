-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — QR contact card opt-in (one-time setup)
-- ═══════════════════════════════════════════════════════════════════
--  WHAT this is for:
--  Scanned QR pages show the artist's social link as a contact card INSTEAD
--  of the work description — but only when the student opts in via the new
--  "Show my social link on my works' QR pages" checkbox in Edit Profile.
--  This flag stores that choice (default OFF = description shows as before).
--
--  HOW TO INSTALL (once, ~1 minute):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done. Until this is run, the checkbox still appears but the QR page
--       keeps showing the description (fails private, never leaks the link).
--
--  PRIVACY NOTE: no RLS change needed. Students already update their own
--  profile rows (Edit Profile), which covers this column, and anonymous QR
--  visitors can only ever SEE the social link when this flag is true — the
--  page logic enforces that, and the default is off.
-- ═══════════════════════════════════════════════════════════════════

alter table user_profiles
  add column if not exists show_social_on_qr boolean not null default false;
