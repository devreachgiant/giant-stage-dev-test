-- A task that is in somebody's Inbox cannot be deleted at all. Twenty of them right now.
--
-- Two rules that are individually reasonable and together make deletion impossible:
--
--   inbox_actions.task_id  ->  tasks(id)  ON DELETE SET NULL
--   CHECK ((message_id IS NOT NULL) <> (task_id IS NOT NULL))   -- exactly one target
--
-- Deleting the task nulls task_id on any inbox row pointing at it, which leaves that row
-- with neither a message nor a task, which is precisely what the check forbids. The check
-- fires, the whole DELETE is rejected, and the person is told their task could not be
-- deleted because of a constraint on a table they have never heard of. It fails on both
-- Projects screens because it is the database refusing, not the UI.
--
-- SET NULL is simply the wrong rule here. An Inbox row about a task is *about that task* --
-- with the task gone there is nothing left for it to be, and no reason to keep a row whose
-- only purpose was to say "this needs you" about work that no longer exists. Cascade.
--
-- chat2_inbox_actions is the old chat's copy and has the identical pair, so it would fail
-- the same way for the same reason; both are corrected together.

alter table public.inbox_actions drop constraint if exists inbox_actions_task_id_fkey;
alter table public.inbox_actions
  add constraint inbox_actions_task_id_fkey
  foreign key (task_id) references public.tasks(id) on delete cascade;

alter table public.chat2_inbox_actions drop constraint if exists chat2_inbox_actions_task_id_fkey;
alter table public.chat2_inbox_actions
  add constraint chat2_inbox_actions_task_id_fkey
  foreign key (task_id) references public.tasks(id) on delete cascade;
