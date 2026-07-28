-- Deleting a user who ever uploaded a chat attachment failed with:
-- "null value in column uploader_id of relation message_attachments violates
-- not-null constraint" — a direct contradiction: the FK is declared
-- ON DELETE SET NULL, but the column itself is NOT NULL, so Postgres can never
-- actually perform the SET NULL it promised. Dropping NOT NULL resolves the
-- contradiction in favor of what the FK already says it does: keep the
-- attachment (and the message it's attached to), just with an unknown uploader
-- once that account is gone, rather than silently blocking user deletion forever.
--
-- Audited every FK referencing profiles(id) with ON DELETE SET NULL for this
-- same contradiction (declared SET NULL + column still NOT NULL) — found one
-- other: workspace_files.uploaded_by. Same fix, same reasoning.

ALTER TABLE "public"."message_attachments" ALTER COLUMN "uploader_id" DROP NOT NULL;
ALTER TABLE "public"."workspace_files" ALTER COLUMN "uploaded_by" DROP NOT NULL;
