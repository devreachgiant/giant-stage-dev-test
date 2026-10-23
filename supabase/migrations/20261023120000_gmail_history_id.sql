-- A mailbox that stays in step with Gmail, instead of one that only ever grows.
--
-- WHAT WAS WRONG. Syncing meant listing the newest N message ids in five label
-- queries and inserting whatever was not already stored. That can only ADD. Archive a
-- message in Gmail, delete it, read it on your phone, star it from the web -- Giant
-- never hears about any of it, so the two lists drift apart from the first day and
-- never come back together. It is also the reason the window had to stay small: the
-- scan cost the same whether anything had changed or not.
--
-- WHAT history_id IS. Gmail keeps a per-mailbox change log. Ask it "what has happened
-- since <history_id>" and it answers with exactly the additions, deletions and label
-- changes -- usually nothing, for a few hundred bytes. That is cheap enough to run
-- every few minutes from a scheduled function, which is what makes the inbox live
-- rather than a snapshot of whenever somebody last opened the tab.
--
-- WHY IT CAN BE NULL. The first sync of a mailbox has no history to ask about, so it
-- does the full scan and records where it got to. Google also expires history that is
-- more than about a week old: that comes back as a 404, the column is cleared, and the
-- next run falls back to the full scan. Null therefore means "start from scratch",
-- which is the correct behaviour in both cases.

alter table public.gmail_tokens
  add column if not exists history_id text;

comment on column public.gmail_tokens.history_id is
  'Gmail''s change cursor for this mailbox. Null means the next sync does a full scan '
  'and records a new one -- true for a mailbox never synced, and for one whose history '
  'Google has since expired.';
