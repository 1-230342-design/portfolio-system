-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — integrity attempt log (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHY this exists:
--  Both gates in js/app.js run BEFORE anything reaches Cloudinary or the
--  database:
--    • runOriginalityCheckUI() blocks a >=90% copy of an existing work;
--    • aiScreenFile() blocks a >=97% AI-generated image.
--  That is good for storage, but it means a blocked attempt leaves no trace
--  at all. The professor can see "this submission is 88% similar" and can
--  never see "this student tried three times and was stopped" — which is
--  exactly what Rankings → Integrity needs to list.
--
--  HOW IT IS USED:
--  The student's browser calls log_integrity_attempt() the moment a block
--  fires. A student can only ever write their OWN row (student_id is taken
--  from auth.uid(), never from the request body), and the table has no
--  direct API access at all. Professors read it through
--  list_integrity_attempts(), which re-checks the department inside the
--  database, and record a verdict with decide_integrity_attempt().
--
--  The app treats this as optional: without this script Rankings →
--  Integrity still lists AI flags (portfolio_items.ai_score) and logged
--  similarity matches (similarity_logs); it simply cannot show the blocked
--  attempts. One hint is written to the console.
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — verify with:  select * from list_integrity_attempts();
-- ═══════════════════════════════════════════════════════════════════

create table if not exists integrity_attempts (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null,
  assignment_id   uuid,
  kind            text not null
                  check (kind in ('duplicate', 'ai_generated', 'exact_copy', 'cross_assignment')),
  score           numeric(5,4),          -- 0.0000 .. 1.0000 (similarity or AI likelihood)
  matched_item_id uuid,                  -- the work it was too close to (may be deleted later)
  outcome         text not null default 'blocked'
                  check (outcome in ('blocked', 'flagged')),
  status          text not null default 'pending'
                  check (status in ('pending', 'confirmed', 'dismissed')),
  decided_by      uuid,
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists integrity_attempts_student_idx on integrity_attempts (student_id);
create index if not exists integrity_attempts_created_idx on integrity_attempts (created_at desc);

alter table integrity_attempts enable row level security;
-- Intentionally zero policies: functions only.

-- ── helper: is the caller a FULL-ACCESS professor? ──
-- Reviewer-only accounts (other departments) can view students, but they
-- must not see or decide misconduct records — same rule the grading
-- rubric already follows in the app.
create or replace function _is_full_professor()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_profiles
     where user_id = auth.uid()
       and role in ('professor', 'admin')
       and department = 'BS Information Technology Major in Multimedia Arts'
  );
$$;

-- ── student-side: record a blocked attempt (fire-and-forget) ──
create or replace function log_integrity_attempt(
  p_kind            text,
  p_score           numeric default null,
  p_matched_item_id uuid    default null,
  p_assignment_id   uuid    default null,
  p_outcome         text    default 'blocked'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;
  if p_kind is null or p_kind not in ('duplicate', 'ai_generated', 'exact_copy', 'cross_assignment') then
    raise exception 'Unknown integrity check type: %', p_kind;
  end if;

  insert into integrity_attempts (student_id, assignment_id, kind, score, matched_item_id, outcome)
  values (
    auth.uid(),
    p_assignment_id,
    p_kind,
    case when p_score is null then null else least(greatest(p_score, 0), 1) end,
    p_matched_item_id,
    case when p_outcome in ('blocked', 'flagged') then p_outcome else 'blocked' end
  )
  returning id into v_id;

  return v_id;
end
$$;

-- ── professor-side: the list behind Rankings → Integrity ──
create or replace function list_integrity_attempts(p_limit integer default 500)
returns table(
  id             uuid,
  student_id     uuid,
  student_name   text,
  student_number text,
  section        text,
  assignment_id  uuid,
  kind           text,
  score          numeric,
  outcome        text,
  status         text,
  matched_item_id uuid,
  matched_title  text,
  created_at     timestamptz,
  decided_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _is_full_professor() then
    raise exception 'Only Multimedia Arts professors can view integrity attempts.';
  end if;

  return query
    select a.id,
           a.student_id,
           coalesce(p.full_name, 'Student'),
           coalesce(p.student_id, ''),
           coalesce(p.section, ''),
           a.assignment_id,
           a.kind,
           a.score,
           a.outcome,
           a.status,
           a.matched_item_id,
           mi.title,
           a.created_at,
           a.decided_at
      from integrity_attempts a
      left join user_profiles  p  on p.user_id = a.student_id
      left join portfolio_items mi on mi.id = a.matched_item_id
     order by a.created_at desc
     limit greatest(1, least(coalesce(p_limit, 500), 2000));
end
$$;

-- ── professor-side: confirm or dismiss a case ──
-- 'confirmed' = the professor looked at the evidence and agrees it was a
-- genuine attempt. 'dismissed' = false positive (stylised art, shared class
-- template…). Rows are never deleted, so the audit trail stays intact.
create or replace function decide_integrity_attempt(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _is_full_professor() then
    raise exception 'Only Multimedia Arts professors can decide integrity cases.';
  end if;
  if p_status is null or p_status not in ('pending', 'confirmed', 'dismissed') then
    raise exception 'Unknown status: %', p_status;
  end if;
  update integrity_attempts
     set status = p_status,
         decided_by = auth.uid(),
         decided_at = now()
   where id = p_id;
end
$$;

grant execute on function log_integrity_attempt(text, numeric, uuid, uuid, text) to authenticated;
grant execute on function list_integrity_attempts(integer) to authenticated;
grant execute on function decide_integrity_attempt(uuid, text) to authenticated;
