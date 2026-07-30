-- Manual drag-to-reorder for passwords within a folder (Nishchay: "add here numbers and make
-- this draggable if we want to change order of this"). sort_order is per-folder, 0-based,
-- backfilled from created_at so existing entries keep their current order.

ALTER TABLE "public"."password_entries" ADD COLUMN IF NOT EXISTS "sort_order" integer;

WITH "ranked" AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "folder_id" ORDER BY "created_at") - 1 AS "rn"
  FROM "public"."password_entries"
)
UPDATE "public"."password_entries" "pe"
SET "sort_order" = "ranked"."rn"
FROM "ranked"
WHERE "pe"."id" = "ranked"."id";

ALTER TABLE "public"."password_entries" ALTER COLUMN "sort_order" SET DEFAULT 0;
ALTER TABLE "public"."password_entries" ALTER COLUMN "sort_order" SET NOT NULL;
