-- Forwarding a message, the way Slack does it.
--
-- The forwarded copy carries a SNAPSHOT of what it is quoting, not a foreign key to it.
-- A reference would have been the obvious schema and it is the wrong one here, for three
-- separate reasons:
--
--   1. RLS. Rendering a reference means joining back to the original, and the original
--      lives in a channel the reader may not be in -- which is the ordinary case, since
--      forwarding exists to move something ACROSS that boundary. The join returns nothing
--      and the forward renders blank for exactly the people it was sent to.
--   2. Deletion. The author deleting their original would silently empty every forward of
--      it, months later, in conversations they have never seen.
--   3. Editing. A forward is a quote of what was said at the time. If the original is
--      edited afterwards, the quote should not change underneath the people discussing it.
--
-- So this is what was on screen when the forward was made: who wrote it, where, when, and
-- what it said. The original's id is kept too, for a "go to the original" link -- which is
-- allowed to fail, because that one SHOULD depend on whether you can see it.
--
-- Attachments are copied as their own message_attachments rows pointing at the same
-- storage objects. No file is re-uploaded, and the forwarded copy renders and downloads
-- through exactly the same path as any other attachment.

alter table public.messages
  add column if not exists forwarded_from jsonb;

comment on column public.messages.forwarded_from is
  'Snapshot of the message this one forwards: {message_id, author_id, author_name, '
  'channel_id, channel_name, body, created_at}. A snapshot and not a reference, because '
  'the original usually sits in a channel the reader cannot see, and a join would render '
  'the forward blank for them. Null on an ordinary message.';
