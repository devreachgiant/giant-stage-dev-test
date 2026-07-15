-- Support scheduling thread replies (not just top-level channel messages).

ALTER TABLE "public"."scheduled_messages"
    ADD COLUMN "parent_id" "uuid" REFERENCES "public"."messages"("id") ON DELETE CASCADE;

CREATE INDEX "scheduled_messages_parent_idx" ON "public"."scheduled_messages" USING "btree" ("parent_id") WHERE ("parent_id" IS NOT NULL);
