-- Replaces the Help Us Improve status vocabulary end to end: drops New/Triaged/
-- Fixed/Won't fix/Done, keeps Ready for review/Closed, and adds the ops-focused
-- statuses actually wanted (Roadblock, On hold, Waiting for approval). Fixed and
-- Done both collapse into "All good" — they meant the same thing in practice.
-- Postgres enums can't drop or rename values in place, so this swaps in a new type.

CREATE TYPE "public"."report_status_new" AS ENUM (
    'not_started',
    'in_progress',
    'ready_for_review',
    'all_good',
    'roadblock',
    'on_hold',
    'waiting_for_approval',
    'closed'
);

ALTER TABLE "public"."reports"
    ALTER COLUMN "status" DROP DEFAULT,
    ALTER COLUMN "status" TYPE "public"."report_status_new"
        USING (
            CASE "status"::text
                WHEN 'new' THEN 'not_started'
                WHEN 'triaged' THEN 'not_started'
                WHEN 'in_progress' THEN 'in_progress'
                WHEN 'ready_for_review' THEN 'ready_for_review'
                WHEN 'fixed' THEN 'all_good'
                WHEN 'done' THEN 'all_good'
                WHEN 'wont_fix' THEN 'closed'
                WHEN 'closed' THEN 'closed'
            END
        )::"public"."report_status_new",
    ALTER COLUMN "status" SET DEFAULT 'not_started';

DROP TYPE "public"."report_status";
ALTER TYPE "public"."report_status_new" RENAME TO "report_status";
