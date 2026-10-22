-- Best calls becomes curated, not shared-write.
--
-- 20261021140000 made growth_watch_calls deliberately shared-write, and said so:
-- "a reading list, not a record: Luke adds one for everybody, a rep adds one they found.
-- Shared-read-only would mean a rep has to ask for a link to be added, which is how a
-- list stops being used."
--
-- That was the wrong read of what the list is for. It is not a scratchpad, it is the
-- Best calls shelf in Training: the calls Luke has chosen because they teach something,
-- with the lesson written underneath. A rep adding their own changes what the shelf
-- means. Nishchay asked for the same rule as the rest of Training -- staff write, a rep
-- reads and ticks -- so this makes the database agree with that.
--
-- Reading is untouched: every rep still sees every call and every lesson on it.

drop policy if exists growth_watch_insert on public.growth_watch_calls;
create policy growth_watch_insert on public.growth_watch_calls
  for insert to authenticated
  with check ((select public.growth_is_staff()));

drop policy if exists growth_watch_change on public.growth_watch_calls;
create policy growth_watch_change on public.growth_watch_calls
  for update to authenticated
  using ((select public.growth_is_staff())) with check ((select public.growth_is_staff()));

drop policy if exists growth_watch_delete on public.growth_watch_calls;
create policy growth_watch_delete on public.growth_watch_calls
  for delete to authenticated
  using ((select public.growth_is_staff()));
