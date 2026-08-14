-- Workspace → Tasks now lets users create a task without picking/creating a
-- project first (project becomes an optional grouping, not a mandatory parent).
-- Verified against tasks_insert_workspace/tasks_select_team/tasks_update_team —
-- all broad, non-project-dependent RLS policies — and subtasks/task_comments,
-- which only join on tasks.id, never tasks.project_id. Safe, additive change;
-- the old standalone Projects module keeps requiring a project in its own UI.
alter table public.tasks
  alter column project_id drop not null;
