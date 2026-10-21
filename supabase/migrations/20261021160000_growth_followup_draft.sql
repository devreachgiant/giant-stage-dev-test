-- "Write follow ups" needs somewhere to put what it wrote.
--
-- The Home screen offers to draft a nudge for every client who has gone quiet. Those
-- drafts are not sent -- the whole promise on that screen is "nothing sends without your
-- approval" -- so they have to survive a reload while they wait to be read.
--
-- A column on the deal rather than its own table: a draft belongs to exactly one client,
-- is replaced wholesale when it is rewritten, and is thrown away the moment it is sent or
-- dismissed. A table would be rows nobody ever queries on their own.
--
-- It inherits growth_clients' policies, so a rep's drafts are their own and nobody else's.

alter table public.growth_clients
  add column if not exists follow_up_draft jsonb;

comment on column public.growth_clients.follow_up_draft is
  'An unsent follow-up written by the assistant: {subject, body, written_on, quiet_days}. Cleared when sent or dismissed.';
