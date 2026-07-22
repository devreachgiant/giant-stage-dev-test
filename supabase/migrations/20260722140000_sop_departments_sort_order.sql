-- Lets departments be manually reordered from the Manage departments modal,
-- instead of being stuck in creation order.
ALTER TABLE "public"."sop_departments" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;

WITH ordered AS (
    SELECT "id", row_number() OVER (ORDER BY "created_at") AS rn
    FROM "public"."sop_departments"
)
UPDATE "public"."sop_departments" d
SET "sort_order" = ordered.rn
FROM ordered
WHERE d."id" = ordered."id";
