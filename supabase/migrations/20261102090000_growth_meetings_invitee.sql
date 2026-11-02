-- Growth meetings: keep what the invitee actually told us when they booked.
--
-- The Calendly booking form asks ten questions -- budget range, how ready they are, when
-- they want to start, annual revenue, how they heard about us -- and every answer was
-- thrown away. The sync read the invitee only to find an email to match a deal by, then
-- dropped the payload. So the person running the call had a name and a time, and had to
-- open Calendly in another tab to learn anything about who they were about to speak to.
--
-- One jsonb column rather than a table of answers: the questions are not ours. They are
-- whatever the Calendly event type asks today, they change when Luke edits the form, and
-- nothing here queries across them -- the screen shows the list as given, in Calendly's
-- own order. A normalised answers table would buy joins nobody runs and would need a
-- migration every time a question is added.
--
--   { name, email, phone, timezone, booked_at, qa: [ { q, a }, ... ] }
--
-- ACCESS. This is personal data -- a phone number, a company's revenue band. It is not
-- given its own policy because it must not have one: growth_meetings already refuses
-- clients outright (growth_meetings_no_clients) and limits the rest to staff, or to the
-- owner of the deal the meeting hangs off (growth_meetings_rw). A column inherits both.
-- Anything looser here would be a second, quieter way into the same row.
--
-- Dry run on production inside a rolled-back transaction before this was applied: the
-- column was added, a row written with a nested answer, read back as 'Under 100k', then
-- rolled back -- confirmed afterwards as 0 columns named invitee and 0 rows left behind.

alter table public.growth_meetings
  add column if not exists invitee jsonb;

comment on column public.growth_meetings.invitee is
  'What the invitee told Calendly when booking: name, email, phone, timezone, booked_at '
  'and the booking form questions and answers in the order asked. Written by '
  'netlify/functions/growth-calendly.js. Inherits the table RLS; no policy of its own.';
