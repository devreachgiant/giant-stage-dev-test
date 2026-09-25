-- Accept and Decline on a booking, without making the guest wait.
--
-- A booking is confirmed the moment it is made -- that is the whole reason to leave
-- Calendly, and holding slots as "pending" until a host looks would put that wait straight
-- back. So Accept does not create the booking; it records that the host has SEEN it and is
-- coming. That is the thing a host actually wants from a list: which of these have I dealt
-- with.
--
-- host_accepted_at is therefore an acknowledgement, not a state the guest depends on. The
-- guest's experience is unchanged whether it is set or not.
--
-- Decline is the one that matters to the guest, and it is not a new state either: it
-- cancels, which the app and the API already understand end to end (calendar event removed,
-- mirror row deleted, email sent). decline_reason is kept so the email can say why and so
-- the row still explains itself a month later.

alter table public.bookings
  add column if not exists host_accepted_at timestamptz,
  add column if not exists declined_at      timestamptz,
  add column if not exists decline_reason   text;

comment on column public.bookings.host_accepted_at is
  'When the host acknowledged this booking. Not a precondition for the meeting -- bookings '
  'are confirmed on creation. Null means nobody has looked at it yet.';

comment on column public.bookings.decline_reason is
  'Why the host declined. Shown to the guest in the cancellation email and kept on the row.';

-- status has been free text with no constraint, which is how a typo becomes a booking that
-- no filter matches. These are the four the app writes and reads.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('confirmed', 'cancelled', 'declined', 'completed'));

-- The Booked meetings list sorts by start and filters by status, and this is the index that
-- pairing wants. Partial on the host, because every query there is one host's own list.
create index if not exists bookings_host_start_idx
  on public.bookings (host_profile_id, start_at desc);
