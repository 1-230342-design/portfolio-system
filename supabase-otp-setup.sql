-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — signup OTP storage (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHY this exists:
--  Signup verification died with "could not send verification code" because
--  this table never existed — the app saves the code row BEFORE emailing it.
--
--  SECURITY design (read this before "simplifying" it):
--  The table has NO direct-access policies at all — anonymous users cannot
--  SELECT, INSERT, or UPDATE it, so nobody can list or steal anyone's codes
--  through the API. All access goes through the two SECURITY DEFINER
--  functions below, which only ever touch the single row matching the
--  email + code presented. request_otp also sweeps expired rows each call.
--
--  HOW TO INSTALL (once, ~1 minute):
--    1. Open your Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — the app (v39+) calls these functions instead of the table.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists otp_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  code       text not null,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists otp_codes_email_idx on otp_codes (email);

alter table otp_codes enable row level security;
-- Intentionally zero policies: deny direct access, functions only.

-- v2: expiry is stamped server-side (10 min) so a wrong device clock can never
-- make codes instantly-expired. The app (v41+) calls the 2-argument form.
drop function if exists request_otp(text, text, timestamptz);
drop function if exists request_otp(text, text);

create or replace function request_otp(p_email text, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ASIATECH-ONLY: the system is exclusive to @asiatech.edu.ph addresses
  -- (thesis Scope). Personal Gmails are rejected here so console bypasses of
  -- the app's client-side check still can't get a code emailed.
  if p_email is null or lower(trim(p_email)) not like '%@asiatech.edu.ph' then
    raise exception 'Only @asiatech.edu.ph addresses can request a code.';
  end if;
  delete from otp_codes where expires_at < now() - interval '1 hour';
  insert into otp_codes (email, code, expires_at) values (p_email, p_code, now() + interval '10 minutes');
end
$$;

drop function if exists verify_otp(text, text);

create or replace function verify_otp(p_email text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from otp_codes
   where email = p_email
     and code = p_code
     and used = false
     and expires_at > now()
   order by created_at desc
   limit 1;
  if v_id is null then
    return false;
  end if;
  update otp_codes set used = true where id = v_id;
  return true;
end
$$;

grant execute on function request_otp(text, text) to anon, authenticated;
grant execute on function verify_otp(text, text) to anon, authenticated;
