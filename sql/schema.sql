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

-- Chat history: one row per completed voice session, plus one row per
-- turn inside it. Frontend writes turns to local storage during the
-- session and pushes everything here in a single call once it ends
-- (see POST /chat/sessions) — so these tables only ever get one bulk
-- insert per session, not one write per turn.
create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  turn_count int not null default 0,
  created_at timestamptz default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  turn_index int not null,
  created_at timestamptz default now()
);

create index if not exists chat_messages_session_id_idx on chat_messages(session_id);
create index if not exists chat_sessions_user_id_idx on chat_sessions(user_id);

alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;

drop policy if exists "Users can view own chat sessions" on chat_sessions;
create policy "Users can view own chat sessions"
  on chat_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can view own chat messages" on chat_messages;
create policy "Users can view own chat messages"
  on chat_messages for select
  using (exists (
    select 1 from chat_sessions
    where chat_sessions.id = chat_messages.session_id
    and chat_sessions.user_id = auth.uid()
  ));
-- No insert/update policies for regular users — all writes to these
-- tables go through the backend's admin/service-role client (POST
-- /chat/sessions), which bypasses RLS. This keeps the write path
-- validated server-side instead of trusting the client directly.

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
