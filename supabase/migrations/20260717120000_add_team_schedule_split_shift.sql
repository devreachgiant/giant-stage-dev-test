-- Team Schedule: support an optional second work block per day (split shifts),
-- e.g. Mavelle's 7-10am + 8-12pm EDT pattern. Both columns are nullable —
-- a schedule with only start_time/end_time is a normal single-block day.

ALTER TABLE "public"."team_schedules"
    ADD COLUMN "start_time_2" time,
    ADD COLUMN "end_time_2" time;
