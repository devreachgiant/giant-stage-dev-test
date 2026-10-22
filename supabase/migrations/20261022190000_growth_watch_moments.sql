-- Moments to watch, on a call in the Best calls list.
--
-- A card said a call went well and linked to 41 minutes of video. Nobody watches 41
-- minutes; what people want is the ninety seconds where the price came up. Each moment
-- is the question asked, the theme, and the second it happens at, so the link can open
-- the recording AT that point rather than at the top.
--
-- jsonb rather than a child table: a moment has no life of its own, is only ever read
-- with its call, and is written by whoever is already allowed to edit the call. A table
-- would need its own policies to say exactly that.
--
--   [{ "q": "What does it cost?", "theme": "Price", "s": 182 }]
--
-- Who may write is unchanged: 20261022130000 made these staff-only, and a column added
-- to the table inherits that -- there is no per-column grant here to get wrong.

alter table public.growth_watch_calls
  add column if not exists moments jsonb not null default '[]'::jsonb;

comment on column public.growth_watch_calls.moments is
  'Points in the recording worth watching: [{q, theme, s}] where s is seconds from the start.';
