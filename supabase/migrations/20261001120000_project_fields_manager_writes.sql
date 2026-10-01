-- Changing the SHAPE of a board is a manager's job. Filling it in is everybody's.
--
-- project_fields had exactly one policy, project_fields_visible, FOR ALL:
--
--   EXISTS (SELECT 1 FROM projects p WHERE p.id = project_fields.project_id)
--
-- One rule covering select, insert, update and delete, and its only condition is that the
-- project exists -- evaluated under the caller's own RLS on projects, so in practice it
-- means "any project you can see".
--
-- Measured against production on 2026-10-01, in rolled-back transactions:
--
--   client-portal account   INSERT refused -- 42501, new row violates row-level security
--   member account          INSERT accepted, 1 row
--
-- So clients were never exposed; the projects policy was already carrying that weight.
-- But any member could add, rename, retype, reorder or delete a column on any board they
-- could open -- and a column is shared structure. Deleting one takes every task's value
-- in it with it, and there is no undo.
--
-- Luke asked for this to be manager-level, which is also the floor Projects 2.0 itself
-- sits behind. is_manager_or_owner() is owner, manager and inhouse_dev, so this matches
-- how the rest of the app spells the same idea rather than inventing a second list.
--
-- Reading is left exactly as it was. Everyone who can see a board still sees its columns
-- and their values; they simply cannot restructure it.

drop policy if exists project_fields_visible on public.project_fields;

create policy project_fields_select on public.project_fields
  for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_fields.project_id));

create policy project_fields_write on public.project_fields
  for all to authenticated
  using (
    public.is_manager_or_owner()
    and exists (select 1 from public.projects p where p.id = project_fields.project_id)
  )
  with check (
    public.is_manager_or_owner()
    and exists (select 1 from public.projects p where p.id = project_fields.project_id)
  );
