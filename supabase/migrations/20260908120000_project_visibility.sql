-- Projects become private-by-choice, and a list you are not on stops being readable.
--
-- Today every authenticated user can read every project and every task. Not by policy
-- design -- there are sensible member-based policies already -- but because `projects_all`
-- grants ALL with USING (true), and RLS policies are OR'd, so one permissive true makes
-- every other policy on the table irrelevant. `tasks_select_team` does the same for tasks
-- by granting every non-client read access to all of them.
--
-- Two things had to be true at once for this to work: a project must be hideable, and
-- hiding it must also hide its tasks. All 486 tasks belong to a project, so scoping task
-- visibility to project visibility leaves nothing orphaned.

-- ── 1. a project is public or private ────────────────────────────────────────
-- Default public, deliberately: other code paths create projects without knowing about
-- this column (the original Projects screen among them), and a default of private would
-- have them silently create lists their own team cannot see.
alter table public.projects
  add column if not exists visibility text not null default 'public';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_visibility_check') then
    alter table public.projects
      add constraint projects_visibility_check check (visibility in ('public','private'));
  end if;
end $$;

-- ── 2. who can see everything ────────────────────────────────────────────────
-- An explicit flag rather than a role test. The four people who supervise every list hold
-- four different roles -- inhouse_dev, manager and two owners -- and one of the owners is
-- deliberately included while no other role holder is, so no role expression describes
-- this set. A column can be changed later without a migration.
alter table public.profiles
  add column if not exists can_see_all_projects boolean not null default false;

update public.profiles set can_see_all_projects = true
 where lower(email) in (
   'nishchaypandya461012@gmail.com',  -- Nishchay
   'matthew@reachgiant.com',          -- Matthew
   'big@reachgiant.com',              -- Luke
   'kristinashumi@gmail.com'          -- Kristina
 );

-- ── 3. backfill ──────────────────────────────────────────────────────────────
-- Everything private except the two shared team lists, which are what the workspace
-- actually reads together.
update public.projects set visibility = 'private';
update public.projects set visibility = 'public'
 where name in ('ReachGiant Master List', 'Master List');

-- ── 4. helpers ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER so the lookup itself is not subject to the policy it is used by;
-- STABLE so the planner may call it once per statement rather than once per row.
create or replace function public.can_see_all_projects()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.can_see_all_projects from public.profiles p where p.id = auth.uid()),
    false);
$$;

create or replace function public.can_see_project(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects pr
     where pr.id = p_id
       and ( pr.visibility = 'public'
          or pr.created_by = auth.uid()
          or exists (select 1 from public.project_members m
                      where m.project_id = pr.id and m.profile_id = auth.uid())
          or public.can_see_all_projects() )
  );
$$;

revoke all on function public.can_see_all_projects() from public;
revoke all on function public.can_see_project(uuid) from public;
grant execute on function public.can_see_all_projects() to authenticated;
grant execute on function public.can_see_project(uuid) to authenticated;

-- ── 5. projects: one SELECT policy that says the whole rule ──────────────────
drop policy if exists projects_all on public.projects;                    -- USING (true)
drop policy if exists projects_owner_or_member_select on public.projects; -- subset of the below
drop policy if exists projects_select_members on public.projects;         -- subset of the below

create policy projects_visibility_select on public.projects
  for select to authenticated
  using (
    visibility = 'public'
    or created_by = auth.uid()
    or public.is_project_member(id)
    or public.can_see_all_projects()
  );

-- projects_all also carried UPDATE/DELETE/INSERT for everyone. The owner/member policies
-- that remain cover those, but a private project must not be editable by someone who
-- cannot see it, so the update policy is restated against the same rule.
drop policy if exists projects_owner_or_member_update on public.projects;
create policy projects_visibility_update on public.projects
  for update to authenticated
  using (created_by = auth.uid() or public.is_project_member(id) or public.can_see_all_projects())
  with check (created_by = auth.uid() or public.is_project_member(id) or public.can_see_all_projects());

-- ── 6. tasks: a task is as visible as its project ────────────────────────────
-- tasks_select_by_visible_project already means "the project row is visible to me", so it
-- becomes correct on its own once the project policies above are right. These two are the
-- independent leaks: they grant every non-client access to every task regardless.
drop policy if exists tasks_select_team on public.tasks;
drop policy if exists tasks_update_team on public.tasks;
-- ...and this let anyone signed in insert a task into any project at all.
drop policy if exists tasks_insert_workspace on public.tasks;

create policy tasks_insert_visible_project on public.tasks
  for insert to authenticated
  with check (auth.uid() is not null and public.can_see_project(project_id));

-- ── 7. the client-scope policies were the other reason nothing was hidden ────
-- Both are written as "(NOT is_client_user()) OR mine", which is the right SHAPE for a
-- restriction and the wrong one for a grant: as permissive policies they are OR'd with
-- everything else, so the left half handed every non-client read access to every project
-- and every task -- which is why tightening the policies above changed nothing at all.
-- Recreated AS RESTRICTIVE, which is AND'ed instead, so they go back to meaning what they
-- say: a client sees only their own, and nobody else is granted anything by them.
drop policy if exists projects_client_scope on public.projects;
create policy projects_client_scope on public.projects
  as restrictive for select to authenticated
  using ((not public.is_client_user()) or client_id = public.current_user_client_link());

drop policy if exists tasks_client_scope on public.tasks;
create policy tasks_client_scope on public.tasks
  as restrictive for select to authenticated
  using ((not public.is_client_user())
         or exists (select 1 from public.projects p
                     where p.id = tasks.project_id
                       and p.client_id = public.current_user_client_link()));
