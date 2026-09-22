-- Who may delete a task: the person who created it, or somebody who answers for the whole
-- workspace -- owner, manager, in-house dev. Today that is Luke, Kristina, Matthew and
-- Nishchay.
--
-- Today the database says:
--
--   tasks_delete_editable_project   USING (can_edit_project(project_id))
--   tasks_delete_mgr                USING (is_manager_or_owner() AND can_edit_project(...))
--
-- The first of those lets ANY member of a project delete ANY task in it, and because
-- policies are OR'd the second one narrows nothing at all. Projects 2.0 draws the delete
-- control only for the people above, but the page is not where a rule like this lives:
-- until this is applied anyone who can open the project can still delete somebody else's
-- task by retyping the request.
--
-- Keyed on role, not on a list of people. An earlier draft of this file made it a
-- per-person capability column, because "Luke, Matt and me" excluded Kristina and no role
-- separates one owner from the other. That is not the rule -- the rule is the three roles --
-- so the column is gone: a role already answers this question, it answers it for whoever
-- joins next without anybody remembering to set a flag, and it needs no second source of
-- truth for the page to read.
--
-- Editing is deliberately NOT narrowed. Anybody on a project should still be able to move a
-- task, reassign it, or tick it off; deleting is the only one of those that cannot be undone.

drop policy if exists tasks_delete_editable_project on public.tasks;
drop policy if exists tasks_delete_mgr on public.tasks;

create policy tasks_delete_own_or_manager on public.tasks
  for delete to authenticated
  using (
    public.can_edit_project(project_id)
    and (created_by = auth.uid() or public.is_manager_or_owner())
  );

-- can_edit_project stays in the condition on both sides: being a task's creator must not let
-- somebody delete it out of a project they can no longer open, and being a manager is not a
-- way into a private list either -- can_edit_project excludes managers from those on purpose
-- (see 20260908120000).
