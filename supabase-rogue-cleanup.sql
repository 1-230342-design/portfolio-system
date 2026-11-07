-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — rogue-artwork cleanup + live-only similarity pool
--  Run once in Supabase SQL Editor to (a) point the similarity RPCs at
--  live submissions only and (b) delete existing orphan/broken rows
--  that keep resurfacing as "61% Match" cards with blank thumbnails.
--  Re-runnable. Safe to run repeatedly.
-- ═══════════════════════════════════════════════════════════════════
--  Root cause of rogues: deleting a work removed its Cloudinary file
--  and (in the app) its portfolio_items row, but rows deleted only on
--  the Cloudinary side (or via a portfolio delete) left a fingerprint
--  row behind. The old get_similarity_fingerprints() returned EVERY
--  portfolio_items row — including drafts (private personal gallery /
--  withdrawn work), orphans, and file-less rows. This file makes the
--  pool LIVE-ONLY (status <> 'draft' + file_url present + joined
--  portfolio) and, below, deletes the true garbage. Personal-gallery
--  drafts are NEVER deleted here — they only leave the similarity pool.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Live-only RPCs (canonical — keep this after older files) ──
drop function if exists get_similarity_fingerprints(uuid, uuid, uuid);

create or replace function get_similarity_fingerprints(
  p_assignment_id uuid,
  p_owner_id      uuid,
  p_exclude_id    uuid default null
)
returns table(
  item_id          uuid,
  phash            text,
  embedding        text,
  sha256           text,
  title            text,
  file_url         text,
  file_type        text,
  assignment_id    uuid,
  student_id       uuid,
  portfolio_status text,
  portfolio_id     uuid
)
language sql
security definer
set search_path = public
as $$
  select pi.id, pi.phash, pi.embedding, pi.sha256, pi.title,
         pi.file_url, pi.file_type, p.assignment_id, p.student_id,
         p.status, p.id
    from portfolio_items pi
    join portfolios p on p.id = pi.portfolio_id
   where (p.assignment_id is not distinct from p_assignment_id)
     and p.status is distinct from 'draft'
     and pi.file_url is not null and btrim(pi.file_url) <> ''
     and (p_owner_id is null or p.student_id is distinct from p_owner_id)
     and (p_exclude_id is null or pi.id <> p_exclude_id);
$$;
grant execute on function get_similarity_fingerprints(uuid, uuid, uuid) to authenticated;

drop function if exists get_cross_assignment_duplicates(text, uuid, uuid);

create or replace function get_cross_assignment_duplicates(
  p_phash         text,
  p_owner_id      uuid,
  p_assignment_id uuid
)
returns table(item_id uuid, title text, assignment_id uuid, student_id uuid)
language sql
security definer
set search_path = public
as $$
  select pi.id, pi.title, p.assignment_id, p.student_id
    from portfolio_items pi
    join portfolios p on p.id = pi.portfolio_id
   where p_phash is not null and pi.phash is not null
     and char_length(pi.phash) = char_length(p_phash)
     and phash_bits_different(pi.phash, p_phash) <= 1
     and p.status is distinct from 'draft'
     and pi.file_url is not null and btrim(pi.file_url) <> ''
     and (p.assignment_id is distinct from p_assignment_id)
     and (p_owner_id is null or p.student_id is distinct from p_owner_id)
   limit 5;
$$;
grant execute on function get_cross_assignment_duplicates(text, uuid, uuid) to authenticated;

-- ── 2. Delete true orphans: item whose portfolio is gone ──
-- (personal drafts with a live portfolio are NOT touched.)
begin;
delete from similarity_logs
 where checked_item_id in (
         select pi.id from portfolio_items pi
         left join portfolios p on p.id = pi.portfolio_id
         where p.id is null
       )
    or matched_item_id in (
         select pi.id from portfolio_items pi
         left join portfolios p on p.id = pi.portfolio_id
         where p.id is null
       );

delete from portfolio_items pi
 using portfolios p
 where pi.portfolio_id = p.id
   and false; -- placeholder keeps the shape obvious; orphans below do the work

delete from portfolio_items
 where portfolio_id not in (select id from portfolios);

-- ── 3. Delete file-less rows (file_url cleared / never saved) ──
delete from similarity_logs
 where checked_item_id in (select id from portfolio_items where file_url is null or btrim(file_url) = '')
    or matched_item_id in (select id from portfolio_items where file_url is null or btrim(file_url) = '');

delete from portfolio_items
 where file_url is null or btrim(file_url) = '';

-- ── 4. Delete similarity logs pointing at items that no longer exist ──
delete from similarity_logs
 where checked_item_id not in (select id from portfolio_items)
    or matched_item_id not in (select id from portfolio_items);

commit;

-- ── 5. Verify (optional — all should return 0) ──
-- select count(*) as orphans from portfolio_items pi
--   left join portfolios p on p.id = pi.portfolio_id where p.id is null;
-- select count(*) as file_less from portfolio_items
--   where file_url is null or btrim(file_url) = '';
-- select count(*) as draft_candidates from portfolio_items pi
--   join portfolios p on p.id = pi.portfolio_id where p.status = 'draft';
--   -- ^ this last one is INTENTIONALLY non-zero (personal gallery). Those
--   -- rows are kept for the student — the RPCs above simply never return
--   -- them to the similarity scanner.

-- ── Note on Cloudinary-side deletes ──
-- If a work was deleted only inside the Cloudinary dashboard, its
-- file_url is still non-empty, so step 3 can't catch it. The app's
-- isWorkFileLoadable() probe now detects these at review/upload time,
-- purges the dead row on the spot, and picks the next-best live match.
