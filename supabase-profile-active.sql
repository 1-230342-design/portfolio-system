-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — Professor active/inactive flag
--  Adds is_active to user_profiles; disabled accounts can still sign in
--  but cannot access professor functions (server-side gate in login flow).
-- ═══════════════════════════════════════════════════════════════════
alter table public.user_profiles
  add column if not exists is_active boolean not null default true;

-- Index for fast professor listing of active faculty
create index if not exists user_profiles_is_active_idx on public.user_profiles (is_active) where role <> 'student';

-- Super-admin RPC to set a profile active/inactive — log-capable, no data loss
create or replace function public.admin_set_account_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins.';
  end if;
  update public.user_profiles
     set is_active = p_active
   where user_id = p_user_id;
end$$;

-- Login gate — any professor (role=professor|admin) without is_active = true
-- is rejected at sign-in. Defined as a helper so login flow can call it.
create or replace function public.account_active_ok(p_user_id uuid)
returns boolean
language sql security definer set search_path = public
as $$
  select coalesce(
    (select bool_and(is_active) from public.user_profiles
      where user_id = p_user_id and role in ('professor','admin')
    ), true
  );
$$;

grant execute on function public.admin_set_account_active(uuid, boolean) to authenticated;
grant execute on function public.account_active_ok(uuid) to authenticated;
