-- What actually runs for Growth, and what it did.
--
-- The Automations screen exists to answer one question: is the thing that is supposed to
-- be happening actually happening? A screen that answers that from a hard-coded list is
-- worse than no screen, because it says "every 30 minutes" whether or not anything ran.
-- So the scheduled function writes a row here every time it wakes up, and the screen
-- reads these rows and nothing else.
--
-- WHO SEES IT. Everyone in Growth. This is operational information, not a secret: a rep
-- wondering why a booking has not appeared should be able to see that the sync last ran
-- four hours ago and said so.
--
-- WHO WRITES IT. Only the machine. There are no insert, update or delete policies, so
-- the service role key the scheduled function uses is the only thing that can add a row.
-- Nobody signed in can fake a green run.

create table if not exists public.growth_runs (
  id      uuid primary key default gen_random_uuid(),
  job     text not null default 'growth_sync',
  ran_at  timestamptz not null default now(),
  ok      boolean not null default true,
  ms      integer,
  steps   jsonb not null default '[]'::jsonb,   -- [{ k, label, said, ok }]
  note    text default ''
);
create index if not exists growth_runs_when_idx on public.growth_runs(job, ran_at desc);

alter table public.growth_runs enable row level security;

-- Clients of the agency stay out, restrictively so it ANDs rather than being OR'd away.
drop policy if exists growth_runs_no_clients on public.growth_runs;
create policy growth_runs_no_clients on public.growth_runs
  as restrictive for all to authenticated
  using ((select public.growth_is_client()) = false)
  with check ((select public.growth_is_client()) = false);

drop policy if exists growth_runs_read on public.growth_runs;
create policy growth_runs_read on public.growth_runs
  for select to authenticated using (true);

-- No write policies. See above.
revoke all on public.growth_runs from anon;
