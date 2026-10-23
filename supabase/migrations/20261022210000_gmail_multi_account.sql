-- More than one Gmail account per person, and tokens that outlive the hour.
--
-- TWO PROBLEMS, ONE SHAPE.
--
-- 1. gmail_tokens was PRIMARY KEY (profile_id): one row per person, so connecting a
--    second mailbox overwrote the first. The key becomes (profile_id, slot).
--
-- 2. gcal_tokens already ADVERTISES a second calendar -- the page upserts on
--    (profile_id, slot) and offers "Add another" -- but its primary key is
--    (profile_id) alone, so the second slot could never have been written. Nobody has
--    hit it because the table is empty; it would have failed the first time somebody
--    tried. Same fix, because leaving a known-broken key in place next to the fixed
--    one is how the next person learns the wrong pattern.
--
-- The unique (profile_id, slot) on gcal_tokens becomes the primary key rather than a
-- second constraint saying the same thing.
--
-- NOTHING IS DELETED. The existing row in each table keeps slot 1, which is the slot
-- every current read already asks for by default.

alter table public.gmail_tokens
  add column if not exists slot smallint not null default 1;

alter table public.gmail_tokens
  add column if not exists label text;

comment on column public.gmail_tokens.slot is
  'Which of this person''s mailboxes. 1 is the one they send from by default.';
comment on column public.gmail_tokens.label is
  'What the person calls this mailbox, when the address alone is not enough.';

alter table public.gmail_tokens drop constraint if exists gmail_tokens_pkey;
alter table public.gmail_tokens add primary key (profile_id, slot);

-- gcal_tokens: promote the unique it already has, and drop the key that blocked it.
alter table public.gcal_tokens drop constraint if exists gcal_tokens_pkey;
alter table public.gcal_tokens drop constraint if exists gcal_tokens_profile_slot_key;
alter table public.gcal_tokens add primary key (profile_id, slot);
