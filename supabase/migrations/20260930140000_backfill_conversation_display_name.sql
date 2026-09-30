-- A renamed conversation was renamed only half way.
--
-- A client row in the sidebar is a CONVERSATION -- General, Google Ads, Meta Ads, SEO, Web
-- are departments INSIDE it, reached from the strip at the top. But each department is its
-- own channels row, and rename wrote to exactly one of them: the General channel, which is
-- the one the sidebar row points at.
--
-- So Tomwellywells Ltd was renamed to stencillab.ai, the sidebar changed, and the moment
-- you clicked Google Ads the header said "Tomwellywells Ltd" again -- reported as the
-- rename not working at all. It had worked, on one of the two rows.
--
-- The app now writes every department of the conversation at once (ncConversationIds, the
-- same union delete already uses). This is the data that was written before it did.
--
-- Which name wins, if departments somehow disagree: General's, else the oldest non-null.
-- General is the one the sidebar row is, so it is the one a person was looking at when
-- they typed the name.
--
-- Measured against production on 2026-09-30 in a rolled-back transaction: one conversation
-- affected, one row updated -- Tomwellywells Ltd's googleAds channel. Nothing else in the
-- table has a display_name yet, so there is nothing else this can reach.
--
-- clients.name is not read or written here. Renaming a conversation never renames a client.

with chosen as (
  select client_id,
         (array_agg(display_name order by (department = 'general') desc, created_at))[1] as nm
    from public.channels
   where kind = 'client_dept' and client_id is not null and display_name is not null
   group by client_id
)
update public.channels c
   set display_name = ch.nm
  from chosen ch
 where c.kind = 'client_dept'
   and c.client_id = ch.client_id
   and c.display_name is distinct from ch.nm;
