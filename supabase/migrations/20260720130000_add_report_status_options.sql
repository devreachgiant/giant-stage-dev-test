-- Adds three more triage stages to Help Us Improve reports, between "Fixed" and being
-- fully closed out: Ready for review, Done, Closed.
ALTER TYPE "public"."report_status" ADD VALUE 'ready_for_review';
ALTER TYPE "public"."report_status" ADD VALUE 'done';
ALTER TYPE "public"."report_status" ADD VALUE 'closed';
