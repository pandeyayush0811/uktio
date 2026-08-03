-- LITE PRACTICE FEATURE — fully isolated schema.
-- Nothing here references or is referenced by chat_sessions / chat_messages /
-- session_reports. To remove the whole feature later: drop these two tables
-- and you're done, the rest of the product is untouched.
--
-- Run this once in Supabase Dashboard -> SQL Editor (separately from schema.sql).

create table if not exists lite_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  turn_count int not null default 0,
  created_at timestamptz default now()
);

create table if not exists lite_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references lite_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  -- Only ever populated on assistant rows: [{ wrong, correct, reason }, ...]
  -- for the mistakes found in the user's turn right before this reply.
  mistakes jsonb,
  turn_index int not null,
  created_at timestamptz default now()
);

create index if not exists lite_turns_session_id_idx on lite_turns(session_id);
create index if not exists lite_sessions_user_id_idx on lite_sessions(user_id);

alter table lite_sessions enable row level security;
alter table lite_turns enable row level security;

drop policy if exists "Users can view own lite sessions" on lite_sessions;
create policy "Users can view own lite sessions"
  on lite_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can view own lite turns" on lite_turns;
create policy "Users can view own lite turns"
  on lite_turns for select
  using (exists (
    select 1 from lite_sessions
    where lite_sessions.id = lite_turns.session_id
    and lite_sessions.user_id = auth.uid()
  ));
-- No insert/update/delete policy for either table — only the backend's
-- service-role client (which bypasses RLS) writes here, same pattern as
-- chat_sessions/chat_messages.
