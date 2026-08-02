-- Run this once in Supabase Dashboard -> SQL Editor.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

-- Users can only ever see/update their own row.
-- (The backend's admin/service-role client bypasses these for auto-creation.)
create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);
