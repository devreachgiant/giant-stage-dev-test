-- Cloud recordings, transcripts, summaries and notes for a Growth call.
--
-- Zoom auto-records every call on this account, and until now none of that reached the
-- app: the recording lived in Zoom, and the only way to find one was to go and look.
-- These columns put the link, what was said, and what we made of it on the call itself,
-- so the row on Meetings is the whole record of the call rather than a time and a name.
--
-- WHY ON growth_meetings AND NOT A TABLE OF ITS OWN. A recording is one-to-one with a
-- call, and Meetings already carries brief/brief_at the same way. A separate table would
-- need its own policies to say the same thing these columns inherit for nothing, and
-- there is already one join in this module (Calendly row vs Zoom row, on the meeting
-- number) that is quite enough to keep straight.
--
-- NO POLICY CHANGE IS NEEDED and none is made. growth_meetings is row-level: the two
-- policies on it -- growth_meetings_no_clients and growth_meetings_rw -- decide whole
-- rows, so a column added today is covered by them the moment it exists. Measured in a
-- rolled-back transaction before this was applied, against a seeded unattached call:
--
--   columns now on the table                        11   (of 11)
--   the seeded row exists                            1
--   client can READ the call                         0
--   client can WRITE a recording url                 0
--   growth role can READ the call                    1
--   growth role can WRITE recording+summary+notes    1
--   member can READ the call                         0
--   the write actually landed                        1
--
-- The client and the member sides are the ones worth having measured: a recording link
-- is a way into a call the person on the other end of it was never meant to re-watch.
--
-- recording_files is jsonb and holds Zoom's own list -- mp4, m4a, cc, chat with sizes --
-- so the screen can say what exists without asking Zoom again on every paint. It is a
-- cache of Zoom's answer, never the source of truth.
--
-- summary_source says whether the words came from Zoom's AI Companion or from Claude
-- reading the transcript. Two summaries of the same call that disagree are a thing
-- somebody will eventually have to explain, and "which one wrote this" is the question
-- they will ask first.

alter table growth_meetings
  add column if not exists recording_url      text,
  add column if not exists recording_passcode text,
  add column if not exists recording_at       timestamptz,
  add column if not exists recording_minutes  integer,
  add column if not exists recording_files    jsonb,
  add column if not exists transcript         text,
  add column if not exists summary            text,
  add column if not exists summary_at         timestamptz,
  add column if not exists summary_source     text,
  add column if not exists notes              text,
  add column if not exists notes_at           timestamptz;
