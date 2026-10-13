-- Profile pictures (default letter avatar stays until set)
-- Run once in Supabase SQL Editor.
alter table user_profiles
  add column if not exists avatar_url text,
  add column if not exists avatar_public_id text;
