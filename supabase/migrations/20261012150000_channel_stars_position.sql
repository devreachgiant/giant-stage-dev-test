-- Starred channels in Chat had no order of their own.
--
-- The Starred card was filled by walking the channel list and copying any row that happened
-- to be starred, so its order was whatever the sidebar built -- channels first, then DMs,
-- alphabetically within each. Nobody chose it and nobody could change it. With six or more
-- starred conversations that is a list you have to read rather than glance at.
--
-- The 48 existing rows across 8 people are backfilled from created_at, so nobody's Starred
-- card changes order the day this ships -- it just becomes something they can change.
--
-- position stays nullable rather than NOT NULL DEFAULT 0, because a star added later arrives
-- without a number and a default of 0 would silently jump it to the top of the list. Null
-- means "not placed yet", and the renderer sorts those after the placed ones by created_at,
-- which is where a newly starred conversation belongs.

alter table public.channel_stars
  add column if not exists position integer;

comment on column public.channel_stars.position is
  'Order of this star in the person''s Starred card, ascending. Null means never reordered; '
  'the renderer falls back to created_at.';

-- Per person, in the order they starred things.
update public.channel_stars s
   set position = n.rn
  from (
    select profile_id, channel_id,
           (row_number() over (partition by profile_id order by created_at, channel_id)) - 1 as rn
      from public.channel_stars
  ) n
 where s.profile_id = n.profile_id
   and s.channel_id = n.channel_id
   and s.position is null;

create index if not exists idx_channel_stars_order
  on public.channel_stars (profile_id, position);
