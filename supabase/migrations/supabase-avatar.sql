-- Profile pictures (letter avatar stays the default until set)
-- Run once in Supabase SQL Editor.
alter table user_profiles
  add column if not exists avatar_url text;
