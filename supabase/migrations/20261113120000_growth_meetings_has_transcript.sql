-- growth_meetings.has_transcript
--
-- WHY A COLUMN RATHER THAN READING THE TRANSCRIPT.
--
-- The Growth screen loads every meeting with select('*'), so all 15 stored transcripts
-- come down on every page load: 362 kB measured today, for text nothing on the screen
-- displays. It grows with every call Zoom syncs and it is paid by everyone who opens
-- Growth, whether or not they look at a call.
--
-- The screen still has to know whether a call HAS one -- that is the difference between
-- offering "Summarise this call" and saying there is nothing to summarise -- so dropping
-- the column from the query takes the answer with it. This is that answer, as one
-- boolean, so the list query can leave the text behind and still render correctly. The
-- transcript itself is fetched for one meeting, when somebody opens it.
--
-- GENERATED, not maintained: a flag something has to remember to set is a flag that goes
-- stale, and this one would go stale exactly when the recordings sync fills a transcript
-- in later -- which is the normal path, because the transcript arrives after the call.
--
-- An empty string is not a transcript. vttToText returns '' when a caption file had
-- nothing usable in it, and a call that offers a summary button over no words is the
-- failure this is meant to prevent.

alter table public.growth_meetings
  add column if not exists has_transcript boolean
  generated always as (transcript is not null and length(btrim(transcript)) > 0) stored;

comment on column public.growth_meetings.has_transcript is
  'Whether transcript holds anything. Lets the pipeline list meetings without pulling the transcript text, which is ~25kB per call.';
