-- A deleted channel can be put back.
--
-- #daily-checkout was deleted on 2026-10-12 and took every message with it. change_history
-- answered WHO deleted it and WHEN, which is what it was built for, but it keeps the channel
-- row alone -- so the channel could be recreated and came back empty. Three months of
-- end-of-day reports are simply gone.
--
-- Deleting a channel cascades to nine tables, and from its messages to six more. One click
-- and there is nothing left to restore from.
--
-- WHY A TRIGGER AND NOT A SOFT DELETE. A deleted_at column would mean finding every read of
-- channels and messages in a 90,000-line file and filtering it, and a single missed one
-- shows a "deleted" channel to somebody. It would also only protect deletions that go
-- through the app -- not a cascade from deleting a client, and not a stray statement run
-- against the database. A BEFORE DELETE trigger catches all of those, and the app does not
-- change at all.
--
-- Timing is the load-bearing detail: a BEFORE DELETE trigger on the parent runs before the
-- row goes, and foreign-key cascades are AFTER-row triggers. So when this fires, every
-- message, member and attachment is still there to be copied.

create table if not exists public.deleted_channel_archive (
  id            uuid primary key default gen_random_uuid(),
  channel_id    uuid not null,
  channel_name  text,
  deleted_at    timestamptz not null default now(),
  deleted_by    uuid,
  message_count integer not null default 0,
  -- The content and the intent behind it.
  channel       jsonb not null,
  members       jsonb not null default '[]'::jsonb,
  messages      jsonb not null default '[]'::jsonb,
  attachments   jsonb not null default '[]'::jsonb,
  reactions     jsonb not null default '[]'::jsonb,
  canvas        jsonb not null default '[]'::jsonb,
  stars         jsonb not null default '[]'::jsonb,
  scheduled     jsonb not null default '[]'::jsonb,
  restored_at   timestamptz,
  restored_by   uuid
);

create index if not exists idx_deleted_channel_archive_at   on public.deleted_channel_archive (deleted_at desc);
create index if not exists idx_deleted_channel_archive_chan on public.deleted_channel_archive (channel_id);

comment on table public.deleted_channel_archive is
  'Snapshot of a channel and its contents, written by a BEFORE DELETE trigger. '
  'Restore with select public.restore_deleted_channel(<archive id>). Service role only.';

-- Deliberately NOT archived: notifications, inbox_actions, message_reads, huddles. Those are
-- per-person ephemeral state -- who had read what, whose inbox it sat in, a call that ended.
-- Restoring them would resurrect stale badges and unread counts for everybody, which is
-- worse than losing them. Attachments ARE archived and the files behind them survive on
-- their own: storage objects are not touched by a database cascade, so restoring the rows
-- restores working downloads.
create or replace function public.archive_channel_before_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_messages jsonb;
  v_count    integer;
begin
  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb), count(*)
    into v_messages, v_count
    from public.messages m where m.channel_id = old.id;

  insert into public.deleted_channel_archive
    (channel_id, channel_name, deleted_by, message_count,
     channel, members, messages, attachments, reactions, canvas, stars, scheduled)
  values (
    old.id,
    coalesce(old.display_name, old.name),
    auth.uid(),
    v_count,
    to_jsonb(old),
    (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.channel_members x where x.channel_id = old.id),
    v_messages,
    (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.message_attachments a
       join public.messages m on m.id = a.message_id where m.channel_id = old.id),
    (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.message_reactions r
       join public.messages m on m.id = r.message_id where m.channel_id = old.id),
    (select coalesce(jsonb_agg(to_jsonb(cv)), '[]'::jsonb) from public.channel_canvas cv where cv.channel_id = old.id),
    (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.channel_stars s where s.channel_id = old.id),
    (select coalesce(jsonb_agg(to_jsonb(sm)), '[]'::jsonb) from public.scheduled_messages sm where sm.channel_id = old.id)
  );
  return old;
end $function$;

drop trigger if exists trg_channels_archive_before_delete on public.channels;
create trigger trg_channels_archive_before_delete
  before delete on public.channels
  for each row execute function public.archive_channel_before_delete();

-- Putting it back.
--
-- Messages go in as ONE statement on purpose: a threaded reply references its parent in the
-- same table, and PostgreSQL checks foreign keys at the end of a statement, so one insert
-- covering parents and replies together satisfies them. Row by row, a reply inserted before
-- its parent would fail.
create or replace function public.restore_deleted_channel(p_archive_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a public.deleted_channel_archive%rowtype;
  v_msgs integer;
begin
  select * into a from public.deleted_channel_archive where id = p_archive_id;
  if not found then
    return 'No archive with that id.';
  end if;
  if exists (select 1 from public.channels where id = a.channel_id) then
    return 'That channel already exists (' || a.channel_id || '). Nothing restored.';
  end if;

  insert into public.channels
    select * from jsonb_populate_record(null::public.channels, a.channel);

  -- Inserting a public channel fires trg_new_public_channel, which adds EVERY profile --
  -- including client accounts. Clear that and put back exactly who was there.
  delete from public.channel_members where channel_id = a.channel_id;
  insert into public.channel_members
    select * from jsonb_populate_recordset(null::public.channel_members, a.members);

  insert into public.messages
    select * from jsonb_populate_recordset(null::public.messages, a.messages);
  get diagnostics v_msgs = row_count;

  insert into public.message_attachments
    select * from jsonb_populate_recordset(null::public.message_attachments, a.attachments);
  insert into public.message_reactions
    select * from jsonb_populate_recordset(null::public.message_reactions, a.reactions);
  insert into public.channel_canvas
    select * from jsonb_populate_recordset(null::public.channel_canvas, a.canvas);
  insert into public.channel_stars
    select * from jsonb_populate_recordset(null::public.channel_stars, a.stars);
  insert into public.scheduled_messages
    select * from jsonb_populate_recordset(null::public.scheduled_messages, a.scheduled);

  update public.deleted_channel_archive
     set restored_at = now(), restored_by = auth.uid()
   where id = p_archive_id;

  return 'Restored ' || coalesce(a.channel_name, a.channel_id::text)
       || ' with ' || v_msgs || ' messages.';
end $function$;

-- Service role only: this table holds the full contents of deleted conversations, including
-- private channels and DMs. RLS on with no policies is what denies everyone else.
alter table public.deleted_channel_archive enable row level security;
revoke all on public.deleted_channel_archive from anon, authenticated;
revoke all on function public.restore_deleted_channel(uuid) from anon, authenticated;
