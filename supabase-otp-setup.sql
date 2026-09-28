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

drop function if exists request_otp(text, text, timestamptz);

create or replace function request_otp(p_email text, p_code text, p_expires_at timestamptz)
returns void
language sql
security definer
set search_path = public
as $$
  delete from otp_codes where expires_at < now() - interval '1 hour';
  insert into otp_codes (email, code, expires_at) values (p_email, p_code, p_expires_at);
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

grant execute on function request_otp(text, text, timestamptz) to anon, authenticated;
grant execute on function verify_otp(text, text) to anon, authenticated;
