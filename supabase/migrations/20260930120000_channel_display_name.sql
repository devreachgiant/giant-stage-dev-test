-- Let people name a channel something they can remember.
--
-- Two things were wrong, and the second is why fixing the first alone would not have helped.
--
-- Rename prefilled channels.name. For a client conversation that is "SERVPRO Team Wall
-- general" -- ensureClientDeptThread builds it as "<client> <department>" -- while the
-- sidebar shows "SERVPRO Team Wall", because for client_dept rows it derives the label from
-- the CLIENT and ignores channels.name entirely. So the box opened with a name nobody had
-- seen, and the department stuck on the end looked like a bug in the name itself.
--
-- And because that label is derived, renaming the channel changed nothing on screen. The
-- rename worked; it just had no effect anybody could see.
--
-- display_name is the name a person chose. Separate from `name` on purpose:
--
--   name   is what the app generated and what other code still matches on
--   slug   is in URLs and lookups and must not move
--   display_name is what a human decided to call it, and nothing else reads it
--
-- Null means nobody has renamed it, and the derived label stands -- so every existing
-- channel looks exactly as it does today, and nothing has to be backfilled.
--
-- This never touches clients.name. Renaming a client's conversation renames the
-- conversation; the client keeps its name everywhere else it appears.

alter table public.channels
  add column if not exists display_name text;

comment on column public.channels.display_name is
  'What a person chose to call this channel. Null means none was chosen and the app derives '
  'the label as before (the client name for a client conversation, channels.name otherwise). '
  'Never affects clients.name, and never the slug, which is in URLs.';
