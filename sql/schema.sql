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
-- Editable system prompts — lets you tune the analysis LLM's behavior
-- from the Supabase dashboard directly, without a code deploy.
create table if not exists prompt_configs (
  key text primary key,
  prompt text not null,
  updated_at timestamptz default now()
);

insert into prompt_configs (key, prompt) values (
  'chat_analysis',
  'Tum ek warm, caring English mentor ho jo ek user aur unke AI voice-practice companion "Bolo" ke beech hui conversation transcript padhte ho. Tumhara kaam hai USER (sirf "user" role wale messages, "assistant" ke nahi) ki English ko dekhna aur unhe ek naturally likha hua, insaan-jaisa report dena — bilkul kisi caring senior ya dost ki tarah, kisi automated "test result" ya formal report card ki tarah bilkul nahi.

ZAROORI: Ye transcript ek VOICE app se aayi hai jahan speech-to-text transcription hui hai — kabhi kabhi transcription hi galat/garbled ho jaati hai (jaise random words, adhoore sentences, ajeeb spellings jo user ne bola hi nahi hoga). Apni samajh se pehchano ki kya cheez genuine English mistake hai aur kya sirf transcription ka glitch hai — agar kuch clearly transcription error lagta hai (matlab hi nahi banta context mein), usse mistake mat maano, use ignore kar do.

Explanation ka style: itna simple likho ki ek 12 saal ka baccha bhi samajh jaaye — koi heavy grammar terminology (jaise "past perfect continuous") mat use karo bina simple tareeke se samjhaye. Jargon-free, warm, encouraging tone rakho.

Har genuine mistake ke liye: user ne jo actually kaha uske jaisa hi topic/style rakhte hue 3-4 additional example sentences do (correct version ke saath) — taaki user ko practice ke liye real, relatable examples milein, generic textbook examples nahi.

Report lamba ho sakta hai, koi problem nahi — thoroughness zaroori hai, brevity nahi.

Structured JSON format mein hi respond karo, jo schema diya gaya hai usी ke according.'
) on conflict (key) do nothing;

-- RLS enabled, deliberately with NO policy for normal users. Without
-- this, the anon key (which ships publicly in config.js) could read
-- this table directly via the REST API — leaking the internal AI
-- prompt. Zero policies = deny-by-default; only the backend's
-- service-role client (which bypasses RLS entirely) can read it.
alter table prompt_configs enable row level security;

-- One report per chat session (enforced by the unique constraint on
-- session_id) — matches the product decision that a session gets
-- analyzed once, on demand, not regenerated automatically.
create table if not exists session_reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references chat_sessions(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  summary text,
  strengths jsonb,       -- string[]
  mistakes jsonb,        -- [{ title, explanation, examples: [{wrong, right}] }]
  practice_tip text,
  model_version text,
  raw_response jsonb,    -- full original model output, kept for debugging/audit only
  generated_at timestamptz default now()
);

create index if not exists session_reports_user_id_idx on session_reports(user_id);

alter table session_reports enable row level security;
drop policy if exists "Users can view own reports" on session_reports;
create policy "Users can view own reports"
  on session_reports for select
  using (auth.uid() = user_id);
-- No insert/update policy — only the backend's admin client writes here.

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