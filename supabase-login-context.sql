-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — login alert: the real request IP (one-time setup, re-runnable)
-- ═══════════════════════════════════════════════════════════════════
--  WHY this exists:
--  The "Someone tried to sign in to your account" email fills in the IP
--  address and approximate location from free third-party lookup services
--  (ipwho.is, ipapi.co, ipify, geojs.io). Ad blockers, privacy browsers,
--  campus/school filters, privacy VPN extensions and flaky mobile data can
--  block ALL of those domains at once — and then the owner receives an alert
--  that says "IP address: Unknown / Approximate location: Unknown", which is
--  useless for deciding whether to change their password.
--
--  This function reads the headers of the request the browser JUST made
--  (PostgREST exposes them) and hands back the caller's own client IP. Our
--  own Supabase project is never blocked by an ad blocker, so the alert keeps
--  working when every third-party service is unreachable.
--
--  PRIVACY / SECURITY:
--  It only ever describes the CALLER's own request — it cannot read another
--  user's IP, another row, or any table. Nothing is stored. No elevated
--  rights are used (plain SQL function, not SECURITY DEFINER), and it is
--  deliberately executable by anonymous visitors because that is exactly the
--  person we need to identify when a login fails.
--
--  The app treats it as optional: if this script has not been run, the RPC
--  fails, the app logs ONE hint to the console and falls back to the public
--  services (plus a device-time-zone hint so the place is never blank).
--
--  HOW TO INSTALL (once, ~30 seconds):
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this entire file and press Run.
--    3. Done — verify with:  select get_login_context();
-- ═══════════════════════════════════════════════════════════════════

create or replace function public.get_login_context()
returns jsonb
language sql
stable
as $$
  with h as (
    select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb as j
  )
  select jsonb_build_object(
    -- x-forwarded-for can be "client, proxy1, proxy2" — the first entry is the browser.
    'ip',   nullif(btrim(split_part(
              coalesce(h.j ->> 'x-forwarded-for', h.j ->> 'x-real-ip', ''),
              ',', 1)), ''),
    'ua',   h.j ->> 'user-agent',
    'lang', h.j ->> 'accept-language'
  )
  from h;
$$;

grant execute on function public.get_login_context() to anon, authenticated;

-- Quick self-check: returns your own IP while you are running this query.
-- select get_login_context();
