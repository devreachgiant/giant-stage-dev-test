-- How the projects bar is arranged, per person.
--
-- projects.position exists but is one number shared by the whole workspace, and it is not
-- even distinct: two projects sit at 1, three at 2 and two at 6, so the bar falls back to
-- whatever order the planner returns for the ties. That is the "random" order.
--
-- Arrangement is personal -- my bar is not everyone's bar -- so it lives per profile, the
-- same way channel_stars already holds a personal star for a conversation.

create table if not exists public.project_prefs (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  position    numeric,               -- null = never dragged, so the default order applies
  starred     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (profile_id, project_id)
);

create index if not exists idx_project_prefs_profile on public.project_prefs (profile_id);

alter table public.project_prefs enable row level security;

-- Your own row and nobody else's, for every verb. There is nothing here anyone else needs.
drop policy if exists project_prefs_own on public.project_prefs;
create policy project_prefs_own on public.project_prefs
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

grant select, insert, update, delete on public.project_prefs to authenticated;
