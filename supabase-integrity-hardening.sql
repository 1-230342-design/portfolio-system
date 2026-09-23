-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — integrity hardening (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  Closes the three known gate bypasses:
--   1. NON-IMAGE FILES — byte-identical copies (PDF/video/ZIP/PSD…) are now
--      caught by a SHA-256 file fingerprint (new `sha256` column below).
--   2. CROSS-ASSIGNMENT COPIES — pixel-identical work submitted under a
--      DIFFERENT assignment (or Upload Work) is now caught by
--      get_cross_assignment_duplicates(). Same-assignment AI rules are
--      untouched; cross-scope only blocks near-identical pixels, so it
--      cannot false-positive on merely similar-looking classwork.
--   3. DEVICE-CLOCK TRICKS — deadlines are now enforced by the DATABASE
--      clock: is_assignment_open() for friendly UI checks, plus a
--      RESTRICTIVE insert policy that rejects late portfolio rows even if
--      someone rewinds their laptop clock or calls the API directly.
--
--  HOW TO INSTALL (once, ~1 minute):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — the app detects each piece and uses it when present.
-- ═══════════════════════════════════════════════════════════════════

-- ── 0. Exact-file fingerprint column (all file types) ──
alter table portfolio_items
  add column if not exists sha256 text;
create index if not exists portfolio_items_sha256_idx on portfolio_items (sha256);

-- ── 1. Same-assignment gate, now also returning sha256 ──
-- (Drop + recreate because the return shape gains a column. Re-running the
--  older supabase-similarity-rpc.sql afterwards would REMOVE sha256 again —
--  don't do that; this file supersedes it.)
drop function if exists get_similarity_fingerprints(uuid, uuid, uuid);

create or replace function get_similarity_fingerprints(
  p_assignment_id uuid,
  p_owner_id      uuid,
  p_exclude_id    uuid default null
)
returns table(
  item_id       uuid,
  phash         text,
  embedding     text,
  sha256        text,
  title         text,
  file_url      text,
  file_type     text,
  assignment_id uuid,
  student_id    uuid
)
language sql
security definer
set search_path = public
as $$
  select pi.id,
         pi.phash,
         pi.embedding,
         pi.sha256,
         pi.title,
         pi.file_url,
         pi.file_type,
         p.assignment_id,
         p.student_id
    from portfolio_items pi
    join portfolios p
      on p.id = pi.portfolio_id
   where (p.assignment_id is not distinct from p_assignment_id)
     and (p_owner_id is null or p.student_id is distinct from p_owner_id)
     and (p_exclude_id is null or pi.id <> p_exclude_id);
$$;

grant execute on function get_similarity_fingerprints(uuid, uuid, uuid) to authenticated;

-- ── 2. Pixel-similarity helper (Hamming distance on 64-bit dHashes) ──
create or replace function phash_bits_different(a text, b text)
returns integer
language sql
immutable
as $$
  select bit_count((('x' || a)::bit(64)) # (('x' || b)::bit(64)));
$$;

-- ── 3. Cross-assignment duplicates: pixel-identical work (at most 1 of 64
-- gradient bits different ≈ 98.4%+) sitting under a DIFFERENT assignment
-- (or plain Upload Work), from another student. Deliberately hash-only:
-- the AI score is never consulted across scopes, so stylised-art AI spikes
-- can never block legitimate different classwork. ──
drop function if exists get_cross_assignment_duplicates(text, uuid, uuid);

create or replace function get_cross_assignment_duplicates(
  p_phash         text,
  p_owner_id      uuid,
  p_assignment_id uuid
)
returns table(
  item_id       uuid,
  title         text,
  assignment_id uuid,
  student_id    uuid
)
language sql
security definer
set search_path = public
as $$
  select pi.id, pi.title, p.assignment_id, p.student_id
    from portfolio_items pi
    join portfolios p
      on p.id = pi.portfolio_id
   where p_phash is not null
     and pi.phash is not null
     and char_length(pi.phash) = char_length(p_phash)
     and phash_bits_different(pi.phash, p_phash) <= 1
     and (p.assignment_id is distinct from p_assignment_id)
     and (p_owner_id is null or p.student_id is distinct from p_owner_id)
   limit 5;
$$;

grant execute on function get_cross_assignment_duplicates(text, uuid, uuid) to authenticated;

-- ── 4. Deadline truth from the DATABASE clock (immune to rewound laptop
-- clocks). The app calls this for its friendly "Closed" UI. ──
drop function if exists is_assignment_open(uuid);

create or replace function is_assignment_open(p_assignment_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (
    select 1 from assignments a
     where a.id = p_assignment_id
       and a.due_date is not null
       and a.due_date <= now()
  );
$$;

grant execute on function is_assignment_open(uuid) to authenticated;

-- ── 5. Deadline enforcement that cannot be bypassed: a RESTRICTIVE insert
-- policy using the database clock. Even a hand-crafted API call with a fake
-- timestamp is rejected — the row is checked against assignments.due_date
-- with now() at insert time. RESTRICTIVE policies narrow whatever permissive
-- student-insert policy you already have; they never widen access. Plain
-- (assignment-less) Upload Work rows are unaffected. ──
drop policy if exists "assignment deadline enforced" on portfolios;

create policy "assignment deadline enforced" on portfolios
  as restrictive for insert
  with check (
    assignment_id is null
    or not exists (
      select 1 from assignments a
       where a.id = assignment_id
         and a.due_date is not null
         and a.due_date <= now()
    )
  );
