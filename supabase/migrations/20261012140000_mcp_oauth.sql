-- "Sign in with Giant", so any AI client can connect any team member.
--
-- A pasted token only works in tools that let you paste one. claude.ai, the Claude desktop
-- app and ChatGPT expect an OAuth sign-in instead, so Giant has to BE an authorization
-- server, not just a protected resource. These three tables are that server's memory.
--
-- Nothing here is ever touched by the browser. Every row is written by a Netlify function
-- holding the service role, so RLS denies everything to everyone else -- there is no policy
-- below on purpose, and RLS is enabled, which in Postgres means "no one but the service role
-- gets a row". An authorization code readable by the person it was issued to would be an
-- authorization code readable by anybody who can run a query as them.
--
-- Secrets are stored as SHA-256 only, the same way api_tokens does it: codes, access tokens
-- and refresh tokens all go in hashed. A database backup is then not a set of live sessions.

-- Clients that have registered themselves. Public clients (no secret, PKCE only), because an
-- app running on somebody's laptop cannot keep a secret and OAuth 2.1 says so plainly.
create table if not exists public.mcp_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris text[] not null,
  -- 'dcr' = it registered itself via RFC 7591. 'cimd' = the client_id IS an https URL
  -- hosting its own metadata, which is what the 2026-07-28 spec prefers.
  origin        text not null default 'dcr',
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

-- Authorization codes. Single use, short lived, bound to a PKCE challenge and to the exact
-- redirect_uri and resource they were issued for.
create table if not exists public.mcp_auth_codes (
  code_hash      text primary key,
  client_id      text not null references public.mcp_clients(client_id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text,
  scope          text not null default 'giant:read',
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists idx_mcp_auth_codes_expiry on public.mcp_auth_codes (expires_at);

-- Issued access tokens, and the refresh token that replaces them. One row per grant: a
-- refresh rotates the access token in place rather than growing the table forever.
--
-- audience is stored because the spec is emphatic about it: a server MUST reject a token
-- that was not issued for itself. Without this column there would be nothing to check
-- against, and a token minted for some other service would sail straight through.
create table if not exists public.mcp_access_tokens (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null references public.mcp_clients(client_id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  token_hash    text unique,
  refresh_hash  text unique,
  audience      text not null,
  scope         text not null default 'giant:read',
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists idx_mcp_tokens_profile on public.mcp_access_tokens (profile_id, created_at desc);
create index if not exists idx_mcp_tokens_live on public.mcp_access_tokens (token_hash) where revoked_at is null;

comment on table public.mcp_clients is
  'AI clients that have registered to connect to Giant over MCP. Public OAuth clients: no '
  'secret, PKCE required. Service-role only.';
comment on table public.mcp_auth_codes is
  'Single-use OAuth authorization codes, stored hashed. Service-role only.';
comment on table public.mcp_access_tokens is
  'OAuth access/refresh tokens for MCP, stored hashed. Every request made with one is '
  'executed AS profile_id, so that person''s own row-level permissions decide what it sees. '
  'Service-role only.';

-- Enabled with NO policies: the service role bypasses RLS, everybody else gets nothing.
alter table public.mcp_clients       enable row level security;
alter table public.mcp_auth_codes    enable row level security;
alter table public.mcp_access_tokens enable row level security;
