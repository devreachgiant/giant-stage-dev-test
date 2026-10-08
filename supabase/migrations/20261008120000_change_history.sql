-- Who changed what, and when.
--
-- Fortess DG turned into five sidebar rows because somebody set its status to churned on
-- 2026-09-29. Finding that out meant reading code, blaming a line and inferring from
-- clients.updated_at -- which records only that SOMETHING changed, on some date, by
-- nobody in particular. The question "was this a bug or did a person do it" could not be
-- answered from the data, and that is the gap this closes.
--
-- clients and channels first, because those are the two that caused it. The trigger is
-- generic, so adding a table later is one more CREATE TRIGGER and nothing else.
--
-- What is stored: the columns that actually CHANGED, old and new. Not the whole row --
-- a row snapshot per edit makes the table enormous and buries the one field you care
-- about, and clients carries contact details and MRR that there is no reason to copy on
-- every unrelated edit.
--
-- auth.uid() is the person. On a change made by a Netlify function with the service-role
-- key it is null, which is itself worth knowing: null means "not a person in the app".

create table if not exists public.change_history (
  id          bigserial primary key,
  table_name  text        not null,
  row_id      uuid        not null,
  action      text        not null check (action in ('insert','update','delete')),
  changed_by  uuid        references public.profiles(id) on delete set null,
  changed_at  timestamptz not null default now(),
  changes     jsonb       not null default '{}'::jsonb,
  label       text
);

create index if not exists idx_change_history_row
  on public.change_history (table_name, row_id, changed_at desc);
create index if not exists idx_change_history_when
  on public.change_history (changed_at desc);

comment on table public.change_history is
  'Who changed what. One row per edit, holding only the columns that changed, old and new. '
  'changed_by null means it was not a signed-in person -- a Netlify function or a migration.';

create or replace function public.record_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed  jsonb := '{}'::jsonb;
  k        text;
  old_j    jsonb;
  new_j    jsonb;
  row_uuid uuid;
  nice     text;
begin
  if tg_op = 'INSERT' then
    new_j := to_jsonb(new); old_j := '{}'::jsonb;
  elsif tg_op = 'DELETE' then
    old_j := to_jsonb(old); new_j := '{}'::jsonb;
  else
    old_j := to_jsonb(old); new_j := to_jsonb(new);
  end if;

  if tg_op = 'UPDATE' then
    -- Only the fields that moved. updated_at changes on every edit and says nothing, so
    -- it is skipped: an entry whose only content is a timestamp is noise.
    for k in select jsonb_object_keys(new_j) loop
      if k <> 'updated_at' and (old_j -> k) is distinct from (new_j -> k) then
        changed := changed || jsonb_build_object(k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k));
      end if;
    end loop;
    if changed = '{}'::jsonb then
      return null;   -- nothing of substance changed; do not write a row
    end if;
  else
    changed := jsonb_build_object('row', coalesce(nullif(new_j, '{}'::jsonb), old_j));
  end if;

  row_uuid := coalesce((new_j ->> 'id')::uuid, (old_j ->> 'id')::uuid);
  -- A name in the log means it reads without joining back to a row that may since be gone.
  nice := coalesce(new_j ->> 'name', old_j ->> 'name');

  insert into public.change_history (table_name, row_id, action, changed_by, changes, label)
  values (tg_table_name, row_uuid, lower(tg_op), auth.uid(), changed, nice);
  return null;
end;
$$;

drop trigger if exists trg_clients_history on public.clients;
create trigger trg_clients_history
  after insert or update or delete on public.clients
  for each row execute function public.record_change();

drop trigger if exists trg_channels_history on public.channels;
create trigger trg_channels_history
  after insert or update or delete on public.channels
  for each row execute function public.record_change();

-- Readable by staff, written only by the trigger. Nobody edits history by hand: a log you
-- can edit answers nothing, and the trigger is SECURITY DEFINER so it writes regardless.
alter table public.change_history enable row level security;

drop policy if exists change_history_read on public.change_history;
create policy change_history_read on public.change_history
  for select to authenticated
  using (coalesce(public."current_role"()::text, 'client') <> 'client');

revoke insert, update, delete on public.change_history from authenticated, anon;
