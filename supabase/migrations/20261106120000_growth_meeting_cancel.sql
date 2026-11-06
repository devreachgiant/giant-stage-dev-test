-- A call that is off should stop being on the screen.
--
-- The Calendly sync has always SKIPPED a cancelled booking -- `if (ev.status ===
-- 'canceled') continue;` -- which keeps it out of the write but never touches the row
-- already there. So a booking cancelled in Calendly stayed in Giant for good. Luke
-- cancelled one, was told it would clear on the next sync, and it would not have cleared
-- ever. One such row existed on the day this was written.
--
-- TWO COLUMNS, BECAUSE THEY ARE TWO DIFFERENT FACTS.
--
--   cancelled_at  the booking is OFF. Calendly is the authority; the sync sets this when
--                 Calendly reports status=canceled, and the Cancel button sets it after
--                 Calendly has accepted the cancellation. Never set speculatively: if
--                 Calendly refuses, the row stays as it was.
--
--   hidden_at     somebody in Giant did not want to look at it any more. The booking may
--                 still be perfectly live in Calendly. This is the one that MUST survive
--                 a sync -- the sync re-writes these rows every five minutes, and a
--                 "remove" that the next run undoes is worse than no button at all.
--
-- Keeping the row rather than deleting it is deliberate. Deleting loses the transcript,
-- the recording and the deal it was attached to, and the next sync would put a bare copy
-- straight back for anything Calendly still considers live.

begin;

alter table growth_meetings
  add column if not exists cancelled_at timestamptz,
  add column if not exists hidden_at    timestamptz,
  add column if not exists hidden_by    uuid references profiles(id) on delete set null;

comment on column growth_meetings.cancelled_at is
  'Set when Calendly reports the booking cancelled, or when Giant cancels it. The call is off.';
comment on column growth_meetings.hidden_at is
  'Set when somebody removed the call from Giant. The Calendly booking may still be live. The sync must never clear this.';

-- Reading the screen means asking "what is still on", so both are filtered on constantly.
create index if not exists growth_meetings_live_idx
  on growth_meetings (starts_at)
  where cancelled_at is null and hidden_at is null;

commit;
