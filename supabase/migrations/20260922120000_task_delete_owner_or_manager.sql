-- NOT APPLIED. Written for review: who may delete a task.
--
-- Nishchay asked that only a task's creator, plus Luke, Matthew and himself, can delete a
-- task. Projects 2.0 now enforces that in the page -- the control is not drawn for anyone
-- else, and the handler checks again before it writes -- but the page is not where a rule
-- like this lives. Today the database says:
--
--   tasks_delete_editable_project   USING (can_edit_project(project_id))
--   tasks_delete_mgr                USING (is_manager_or_owner() AND can_edit_project(...))
--
-- The first of those lets ANY member of a project delete ANY task in it. So until this is
-- applied the new rule is a courtesy: anyone who can open the project can still delete
-- somebody else's task by retyping the request, and nothing stops them.
--
-- The rule below is the creator, or a role that answers for the whole workspace. Keyed on
-- role rather than on three profile ids: a list of names in a policy goes stale the first
-- time somebody joins or leaves, and the person who notices is whoever loses access they
-- should have had. is_manager_or_owner() already covers owner, manager and inhouse_dev,
-- which is Luke, Matthew, Kristina and Nishchay today -- one more than was asked for,
-- because excluding one owner while including a manager is not a rule anybody could
-- remember. Narrowing it to a deliberate flag is a later, smaller change.
--
-- Editing is deliberately NOT narrowed. Anybody on a project should still be able to move
-- a task, reassign it, or tick it off; deleting is the only one of those that cannot be
-- undone.

drop policy if exists tasks_delete_editable_project on public.tasks;
drop policy if exists tasks_delete_mgr on public.tasks;

create policy tasks_delete_own_or_manager on public.tasks
  for delete to authenticated
  using (
    public.can_edit_project(project_id)
    and (created_by = auth.uid() or public.is_manager_or_owner())
  );

-- can_edit_project stays in the condition: being a task's creator must not let somebody
-- delete it out of a project they can no longer open at all.
