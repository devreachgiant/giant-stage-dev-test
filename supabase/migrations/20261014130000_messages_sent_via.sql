-- "Sent using ChatGPT", on the message itself.
--
-- An assistant granted writing posts as the person: the message appears under their name,
-- with nothing saying a machine wrote it. That is fine when you asked for it and misleading
-- to everyone else in the channel -- Slack labels these for the same reason.
--
-- Null for anything a person typed, which is almost every row, so this costs nothing to
-- store and the renderer shows a badge only when there is something to say.
alter table public.messages
  add column if not exists sent_via text;

comment on column public.messages.sent_via is
  'The AI assistant that posted this on the author''s behalf, e.g. ChatGPT. Null when a '
  'person typed it. Set by the MCP server; the app never writes it.';
