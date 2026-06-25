-- =====================================================================
--  GutachtAI – Supabase Schema
--  Im Supabase Dashboard -> SQL Editor einfügen und ausführen.
-- =====================================================================

create table if not exists public.reports (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  project_id         text not null,
  user_id            uuid,
  room_or_section    text,
  raw_transcript     text,
  structured_content jsonb
);

-- Schneller Filter nach Projekt
create index if not exists reports_project_id_idx on public.reports (project_id);

-- =====================================================================
--  RLS-Hinweis:
--  Das Backend nutzt den SERVICE_ROLE_KEY und umgeht RLS bewusst
--  (Server-seitig, Key liegt NIE im Frontend). Für reine Server-Nutzung
--  kannst du RLS anlassen ODER aktivieren – beides funktioniert,
--  solange ausschließlich der Server schreibt/liest.
--
--  Wenn du RLS aktivierst und KEINE Policies anlegst, ist die Tabelle
--  für anon/authenticated dicht – exakt was du willst:
-- =====================================================================
alter table public.reports enable row level security;
