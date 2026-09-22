-- A task's stage: the nine-step pipeline, alongside the four-value status it already has.
--
-- tasks.status is a Postgres enum (task_status) with todo / in_progress / done / blocked,
-- and it is read by the original Projects screen, the Active/Done counts, Team Pulse and
-- the reports. Adding nine values to an enum is close to irreversible -- Postgres will add
-- but not remove them -- and it would put words in front of code on other screens that has
-- never seen them.
--
-- So the stage is its own column, which is the pattern this table already uses: priority
-- has priority_label beside it, and so do importance and resistance. The enum stays the
-- coarse machine value every other screen reads; the stage is the detail Projects 2.0
-- shows, and the two are kept in step whenever either is written.
--
-- It stores the KEY, not the words. "Waiting on another team" will get re-worded by
-- somebody eventually, and a column full of display text means a data migration every time
-- that happens. The labels live in the page.

alter table public.tasks add column if not exists status_stage text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_status_stage_check') then
    alter table public.tasks add constraint tasks_status_stage_check
      check (status_stage is null or status_stage in (
        'new_request','needs_detail','not_started','in_progress',
        'review','waiting','on_hold','roadblock','done'));
  end if;
end $$;

-- Backfill from what the enum already says, so nothing starts blank. The four values map
-- onto the nearest stage; the finer distinctions are ones nobody has recorded yet and
-- cannot be invented here.
update public.tasks set status_stage =
  case status::text
    when 'done'        then 'done'
    when 'in_progress' then 'in_progress'
    when 'blocked'     then 'roadblock'
    else                    'not_started'
  end
 where status_stage is null;

-- The board filters and groups by it.
create index if not exists idx_tasks_status_stage on public.tasks (status_stage)
  where status_stage is not null;

-- No policy changes: status_stage is a column on tasks and inherits every policy the
-- table already has.
