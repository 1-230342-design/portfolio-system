-- ═══════════════════════════════════════════════════════════════════
--  Artfolio — Super Admin Extended
--  Adds:
--    1. system_settings table (no policies — RPCs only)
--    2. portfolio_items.expired_at (mark auto-expired outputs)
--    3. admin_storage_report() — per-student bytes grouped by section
--    4. admin_storage_totals() — aggregate bytes per section
--    5. admin_users_password_targets() — quick lookup of auth users for
--       the Reset/Temp password flows (super-admin-gated)
--    6. admin_system_settings_get / set — placeholder for auto-expiry
--       settings (how we remember the cut-off date)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Settings table ──────────────────────────────────────────────
create table if not exists public.system_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.system_settings enable row level security;
-- no policies → only security-definer RPCs read/write

insert into public.system_settings(key, value) values
  ('outputs_expire_at', 'null'::jsonb),
  ('outputs_expire_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ── 2. expiry column on items ─────────────────────────────────────
alter table public.portfolio_items
  add column if not exists expired_at timestamptz;

-- ── 3. Storage report per student, grouped by section ─────────────
create or replace function public.admin_storage_report()
returns table(
  section        text,
  student_id     uuid,
  student_name   text,
  student_number text,
  files          bigint,
  total_bytes    bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins.';
  end if;
  return query
    select coalesce(nullif(btrim(sp.section),''), 'Unenrolled') as section,
           sp.user_id::uuid,
           coalesce(sp.full_name, 'Student'),
           coalesce(sp.student_id, ''),
           count(i.id)::bigint,
           coalesce(sum(i.file_size_bytes), 0)::bigint
      from public.user_profiles sp
      join public.portfolios    p on p.student_id = sp.user_id
      join public.portfolio_items i on i.portfolio_id = p.id
     where sp.role = 'student'
       and i.cloudinary_public_id is not null
     group by 1, sp.user_id, sp.full_name, sp.student_id
     order by 1 asc, 6 desc, 3 asc;
end$$;

-- ── 4. Aggregated bytes per section ────────────────────────────────
create or replace function public.admin_storage_totals()
returns table(
  section        text,
  students       bigint,
  files          bigint,
  total_bytes    bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins.';
  end if;
  return query
    select coalesce(nullif(btrim(sp.section),''), 'Unenrolled') as section,
           count(distinct sp.user_id)::bigint as students,
           count(i.id)::bigint                as files,
           coalesce(sum(i.file_size_bytes), 0)::bigint as total_bytes
      from public.user_profiles sp
      join public.portfolios    p on p.student_id = sp.user_id
      join public.portfolio_items i on i.portfolio_id = p.id
     where sp.role = 'student'
       and i.cloudinary_public_id is not null
     group by 1
     order by 4 desc, 1 asc;
end$$;

-- ── 5. User lookup for password flow (super-admin gate) ────────────
create or replace function public.admin_password_targets()
returns table(
  user_id      uuid,
  email        text,
  full_name    text,
  role         text,
  student_id   text,
  section      text
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins.';
  end if;
  return query
    select u.user_id, u.email, u.full_name, u.role,
           coalesce(u.student_id, ''), coalesce(u.section, '')
      from public.user_profiles u
     where u.role in ('student', 'professor')
     order by u.full_name;
end$$;

-- ── 6. Settings read/write RPC ─────────────────────────────────────
create or replace function public.admin_get_system_settings()
returns table(key text, value jsonb, updated_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins.';
  end if;
  return query select s.key, s.value, s.updated_at from public.system_settings s order by s.key;
end$$;

create or replace function public.admin_set_system_setting(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins.';
  end if;
  insert into public.system_settings(key, value, updated_at)
    values (p_key, p_value, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
end$$;

-- Permissions: only authenticated, and only the caller-visible set
grant execute on function public.admin_storage_report() to authenticated;
grant execute on function public.admin_storage_totals() to authenticated;
grant execute on function public.admin_password_targets() to authenticated;
grant execute on function public.admin_get_system_settings() to authenticated;
grant execute on function public.admin_set_system_setting(text, jsonb) to authenticated;
