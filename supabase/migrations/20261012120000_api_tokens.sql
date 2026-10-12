-- Personal tokens, so somebody can connect an AI assistant to Giant.
--
-- One row per connection a person makes: "Luke's Claude", "Nishchay's Cursor". The token
-- itself is never stored -- only a SHA-256 of it. A leaked database backup therefore hands
-- nobody a working key, and the app can only ever show the token once, at the moment it is
-- created, which is the honest behaviour anyway.
--
-- The prefix IS stored, so a person can tell their tokens apart in a list and revoke the
-- right one without being shown the secret again.
--
-- Scoped to a PERSON, not to the workspace. Whatever an AI asks for comes back under that
-- person's own permissions, so connecting an assistant can never show somebody more than
-- they could already see by opening the app. That is the whole security model, and the
-- reason this is a per-user token rather than one shared key.
--
-- Revoking is a timestamp rather than a delete: knowing a token existed, who made it and
-- when it was last used is exactly what you want after something goes wrong.

create table if not exists public.api_tokens (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  prefix       text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists idx_api_tokens_profile on public.api_tokens (profile_id, created_at desc);
-- The lookup every request makes: hash the presented token, find a live row.
create index if not exists idx_api_tokens_live on public.api_tokens (token_hash) where revoked_at is null;

comment on table public.api_tokens is
  'Personal API tokens for connecting an AI assistant (MCP). Stores a SHA-256 of the token, '
  'never the token. Every request made with one is executed AS the owning profile, so the '
  'owner''s own row-level permissions decide what it can see.';

alter table public.api_tokens enable row level security;

-- Yours and nobody else's -- including the hash, which is of no use to anyone but is also
-- no business of anyone else's.
drop policy if exists api_tokens_own on public.api_tokens;
create policy api_tokens_own on public.api_tokens
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- A client-portal account has no business connecting an assistant to this workspace.
drop policy if exists api_tokens_no_clients on public.api_tokens;
create policy api_tokens_no_clients on public.api_tokens
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and coalesce(public."current_role"()::text, 'client') <> 'client'
  );
