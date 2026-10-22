-- Somewhere to keep a connector's credential that the page can never read back.
--
-- Calendly needed a Personal Access Token and the only place to put it was
-- CALENDLY_TOKEN in Netlify, which means Nishchay has to leave the app, find the right
-- site, add an environment variable and redeploy before Growth can see a booking. That
-- is not a connector, it is a deployment step. This table is what lets Connectors
-- actually connect something.
--
-- HOW THE SECRET MOVES. Not through this table from the browser. The page posts the
-- token to /.netlify/functions/growth-calendly?action=save over HTTPS; the function
-- checks the caller is staff, proves the token works by calling Calendly with it, and
-- only then writes it here with the service role key. So:
--
--   the browser        never reads a secret, and never writes to this table
--   the function       reads and writes it with the service role key, which bypasses RLS
--   anyone else        nothing
--
-- RLS IS ON WITH NO POLICIES AT ALL. That is deliberate and it is the whole protection:
-- a table with RLS enabled and no policy denies every role that is not the owner or
-- service_role, so the publishable key in config.js -- which is public by design -- gets
-- zero rows whatever it asks for. There is no select policy to get wrong, because there
-- is no select policy. gmail_tokens, by contrast, is readable by the person it belongs
-- to; that is fine for a token scoped to one mailbox, but a Calendly personal token is
-- the whole account, so it gets the stricter shape.

create table if not exists public.growth_secrets (
  key        text primary key,
  value      text not null,
  label      text default '',          -- who the credential belongs to, safe to show
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

alter table public.growth_secrets enable row level security;

-- No policies. See above: this is the point, not an omission.
-- Belt and braces, in case a later migration adds a policy without thinking about anon:
revoke all on public.growth_secrets from anon, authenticated;
