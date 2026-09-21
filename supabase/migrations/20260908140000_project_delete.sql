-- Deleting a project: its creator, or a manager or owner.
--
-- Worth knowing what this destroys. tasks.project_id is ON DELETE CASCADE, so removing a
-- project takes every task in it -- 276 of them in ReachGiant Master List. Logged time
-- survives: time_sessions.project_id is ON DELETE SET NULL, so the hours stay on the
-- person's record even once the project they were spent on is gone.

drop policy if exists projects_owner_delete on public.projects;
create policy projects_delete_creator_or_manager on public.projects
  for delete to authenticated
  using (created_by = auth.uid() or public.is_manager_or_owner());
