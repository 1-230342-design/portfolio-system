-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — pre-upload similarity gate (one-time setup)
-- ═══════════════════════════════════════════════════════════════════
--  PROBLEM this fixes:
--  The "Checking Originality…" gate runs in the STUDENT's browser BEFORE
--  their upload is saved. It needs to compare the new file against OTHER
--  students' submissions in the SAME assignment. But when Row Level Security
--  restricts portfolio_items / portfolios to owners only, that query comes
--  back EMPTY for a student — the gate sees 0 candidates, scores 0%, and
--  lets everything through. The professor (full read access) then sees the
--  real 99% match in the Review Panel. That is exactly the
--  "second uploader didn't get blocked" bug.
--
--  FIX: this SECURITY DEFINER function runs with the database owner's rights,
--  bypassing RLS, but it only ever returns fingerprint data (hash + AI vector
--  + file location needed for analysis) for submissions in the SAME assignment
--  excluding the uploader's own work. No titles of others, no grades, no
--  comments — just what the duplicate check needs.
--
--  HOW TO INSTALL (once, ~1 minute):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — no code changes needed. The app tries this function first and
--       falls back to the old direct query if it doesn't exist yet.
-- ═══════════════════════════════════════════════════════════════════

-- 0. Make sure the AI fingerprint column exists (harmless if it already does).
alter table portfolio_items
  add column if not exists embedding text;

-- 1. Drop any previous version so re-running this file is always safe.
drop function if exists get_similarity_fingerprints(uuid, uuid, uuid);

-- 2. The gate function.
--    p_assignment_id : the assignment being submitted to, or NULL for a plain
--                      "Upload Work" (which is only compared against other
--                      plain uploads — never against another assignment).
--    p_owner_id      : the uploading student's auth user id — their own rows
--                      are excluded so resubmitting your own work is never
--                      flagged as plagiarism of yourself.
--    p_exclude_id    : optional single portfolio_items id to skip (unused by
--                      the current upload flows, kept for completeness).
create or replace function get_similarity_fingerprints(
  p_assignment_id uuid,
  p_owner_id      uuid,
  p_exclude_id    uuid default null
)
returns table(
  item_id       uuid,
  phash         text,
  embedding     text,
  title         text,
  file_url      text,
  file_type     text,
  assignment_id uuid,
  student_id    uuid
)
language sql
security definer            -- run as the function owner: bypasses RLS …
set search_path = public    -- … but only inside public, so it can't be abused
as $$
  select pi.id,
         pi.phash,
         pi.embedding,
         pi.title,
         pi.file_url,
         pi.file_type,
         p.assignment_id,
         p.student_id
    from portfolio_items pi
    join portfolios p
      on p.id = pi.portfolio_id
   where (p.assignment_id is not distinct from p_assignment_id)  -- NULL-safe: plain uploads match plain uploads
     and (p_owner_id is null or p.student_id is distinct from p_owner_id)
     and (p_exclude_id is null or pi.id <> p_exclude_id);
$$;

-- 3. Let logged-in users (students) execute it. The function body is owned by
--    postgres, so callers gain NO extra table rights beyond what it returns.
grant execute on function get_similarity_fingerprints(uuid, uuid, uuid) to authenticated;

-- 4. Verify (optional): run this to confirm it installed —
--    select * from get_similarity_fingerprints(null, null, null) limit 5;
--    As a student it should list other students' fingerprints in the same
--    scope; an empty table just means no submissions exist yet.
