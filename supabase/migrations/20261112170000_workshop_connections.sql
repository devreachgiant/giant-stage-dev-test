-- Per-client connector credentials for Workshop.
--
-- WHY A SECOND TABLE AND NOT growth_secrets. growth_secrets is one row per
-- SERVICE for the whole agency -- calendly_token, zoom_s2s, ahrefs_token -- and
-- that shape is right for Ahrefs, where one key plus a target domain covers all
-- 56 clients. It is wrong for everything else on the Connections screen: a
-- WordPress application password, a Webflow site token, a Search Console
-- property and a client's Calendly all belong to ONE client and must not be
-- reachable from another's screen.
--
-- THE CREDENTIAL IS NEVER READABLE FROM THE BROWSER. RLS is on and there are
-- deliberately NO POLICIES and no grants to anon or authenticated, exactly as
-- growth_secrets has none. The publishable key in config.js is public by
-- design, so a policy that let the page read one row would hand every client's
-- credential to anyone who opened the app. Only the service role touches this,
-- and only inside a Netlify function, which returns status and never the
-- secret.
--
-- meta IS NOT SECRET and that is on purpose: a Search Console property, a GA4
-- property id, a Webflow collection id, a WordPress base URL. Keeping them out
-- of `credential` means a status screen can say WHICH property is connected
-- without the function ever having to decrypt or reveal anything.
--
-- Applied by hand, as everything here is.

create table if not exists public.workshop_connections (
  client_id   uuid not null references public.clients(id) on delete cascade,
  source      text not null,
  status      text not null default 'off',
  credential  text,
  meta        jsonb not null default '{}'::jsonb,
  last_error  text,
  tested_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id),
  primary key (client_id, source),

  -- The set the Connections screen knows about. A typo here would otherwise
  -- create a silent second connector nothing ever reads.
  constraint workshop_connections_source_ck check (source in
    ('wordpress','webflow','shopify','wix','gsc','ga4','gbp','calendly')),
  -- off = nothing stored. ok/failed = stored and last proved, or not.
  constraint workshop_connections_status_ck check (status in ('off','ok','failed'))
);

alter table public.workshop_connections enable row level security;

-- No policies and no grants on purpose. Service role only.
revoke all on public.workshop_connections from anon, authenticated;

comment on table public.workshop_connections is
  'Per-client connector credentials. Service role only: RLS on with no policies and no grants, like growth_secrets. Read and written exclusively by netlify/functions/workshop-connect.js, which never returns the credential column.';
comment on column public.workshop_connections.credential is
  'Secret. Never selected by anything that can reach the browser.';
comment on column public.workshop_connections.meta is
  'Non-secret identifiers only -- property id, site id, base url -- so status can name what is connected without revealing the credential.';
