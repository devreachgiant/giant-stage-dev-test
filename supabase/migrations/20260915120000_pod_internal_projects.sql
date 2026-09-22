-- Internal work: our own properties, not clients.
--
-- The design lists three of them — "INTERNAL · $150/PROJECT TO MAVE" — and pays the lower
-- internal SEO rate for each. They are not clients: nobody invoices them, they have no MRR,
-- no onboarding and no client channel, and putting them in the Clients module to make the
-- board work would have been the board bending the data to suit itself.
--
-- They are, however, exactly an assignment: a piece of work, held by one person, paid at a
-- rate. So they live in pod_assignments alongside client work rather than in a table of
-- their own, and payroll stays one sum over one table. A second table would mean every
-- figure on the board — payroll, a person's pay, their account count — became a sum of two
-- things, and the first one somebody forgot to add would be a silent undercount.

alter table public.pod_assignments alter column client_id drop not null;
alter table public.pod_assignments add column if not exists label text;

-- Exactly one target: a client, or a name. The same shape as inbox_actions_one_target --
-- which is safe here only because client_id cascades on delete rather than nulling. A
-- SET NULL there would leave a row with neither, violate this check, and make deleting a
-- client impossible; that pairing is precisely the bug that made twenty tasks undeletable.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pod_assignments_one_target') then
    alter table public.pod_assignments add constraint pod_assignments_one_target
      check ((client_id is not null) <> (label is not null));
  end if;
end $$;

-- One live row per internal project per service, mirroring the client rule. Postgres treats
-- NULLs as distinct in a unique index, so the existing (client_id, service) index does not
-- constrain these at all and they need their own.
create unique index if not exists idx_pod_assignments_internal_live
  on public.pod_assignments (lower(label), service)
  where ended_at is null and label is not null;

-- The three the design names, as internal SEO work. Unassigned: who holds them is a
-- decision for the board, not for a migration.
insert into public.pod_assignments (label, service, is_internal, tier)
select v.label, 'seo', true, null
from (values ('Reach Giant'), ('Lukas Griffin Artwork'), ('MODIFYR')) as v(label)
where not exists (
  select 1 from public.pod_assignments a
   where a.label is not null and lower(a.label) = lower(v.label) and a.ended_at is null);
