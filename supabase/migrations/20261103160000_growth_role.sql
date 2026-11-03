-- A 'growth' role: the Growth module in full, and the same view of the rest of the app
-- that a manager gets. Added because Annie (role 'member') was already on the
-- growth_settings 'access' allowlist, so the Growth tab was VISIBLE to her and every
-- screen in it was EMPTY -- 0 of 23 deals, 0 of 29 meetings, 0 of 40 tasks. The
-- allowlist only unhides the nav; it says nothing to the row policies, and those read
-- growth_is_staff(), which is a role check. Showing her the door did not unlock it.
--
-- Members are untouched. This adds a role; it changes no existing role's rules.
--
-- ALTER TYPE ... ADD VALUE cannot be dry-run inside a rolled-back transaction the way
-- everything else here is: Postgres will not let the new label be USED in the same
-- transaction that adds it, and an enum label cannot be dropped afterwards. It is
-- applied on its own, first, and the rest follows in a transaction that can be proven.

-- step 1, on its own:
--   alter type public.user_role add value if not exists 'growth';

-- step 2:
create or replace function public.growth_is_staff()
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(
    (select p.role::text in ('owner','manager','inhouse_dev','growth') from public.profiles p where p.id = auth.uid()),
    false);
$function$;

create or replace function public.is_manager_or_owner()
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  SELECT public.current_role() IN ('owner','manager','inhouse_dev','growth')
$function$;

create or replace function public.can_manage_project(p_project_id uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.created_by = auth.uid()
  ) or exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.role in ('owner','manager','inhouse_dev','growth')
  );
$function$;
