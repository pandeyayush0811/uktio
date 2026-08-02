-- Run this once in Supabase Dashboard -> SQL Editor.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz default now(),

  -- Onboarding data (collected once, right after signup)
  name text,
  age int,
  occupation_type text,   -- student | professional
  class_grade text,       -- only set when occupation_type = 'student'  (e.g. "Class 10", "B.Tech 2nd year")
  profession text,        -- only set when occupation_type = 'professional' (e.g. "Software Engineer")
  city text,
  goal text,              -- interview | daily_confidence | exam_prep | travel | content_creation | general
  self_level text,        -- beginner | intermediate | advanced
  english_sample text,    -- free-text sample, saved now, analyzed later
  daily_time text,        -- 5_10 | 15_20 | 30_plus
  onboarding_completed boolean not null default false
);

-- Safe to run again on an existing table — adds columns only if missing.
alter table profiles add column if not exists name text;
alter table profiles add column if not exists age int;
alter table profiles add column if not exists occupation_type text;
alter table profiles add column if not exists class_grade text;
alter table profiles add column if not exists profession text;
alter table profiles add column if not exists city text;
alter table profiles add column if not exists goal text;
alter table profiles add column if not exists self_level text;
alter table profiles add column if not exists english_sample text;
alter table profiles add column if not exists daily_time text;
alter table profiles add column if not exists onboarding_completed boolean not null default false;

-- One-time cleanup if you already ran the older version of this schema
-- that had a single ambiguous "age_or_class" text column.
alter table profiles drop column if exists age_or_class;

alter table profiles enable row level security;

-- Users can only ever see/update their own row.
-- (The backend's admin/service-role client bypasses these for auto-creation.)
-- drop-then-create makes this block safe to re-run anytime.
drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);
