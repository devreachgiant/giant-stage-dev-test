-- Round 3: Canvas tab (shared collaborative doc per thread), mirroring the real
-- channel_canvas table 1:1 (single shared content field, last-writer-wins, synced
-- live via a postgres_changes subscription — not true CRDT collaboration, same as
-- the real one). Own chat2_* table per the isolation rule.

CREATE TABLE IF NOT EXISTS "public"."chat2_thread_canvas" (
    "thread_id" uuid PRIMARY KEY REFERENCES "public"."chat2_threads"("id") ON DELETE CASCADE,
    "content" text,
    "updated_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "public"."chat2_thread_canvas" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat2_thread_canvas_staff_all" ON "public"."chat2_thread_canvas" FOR ALL TO "authenticated"
    USING (NOT "public"."is_client_user"()) WITH CHECK (NOT "public"."is_client_user"());

GRANT ALL ON "public"."chat2_thread_canvas" TO "authenticated";
GRANT ALL ON "public"."chat2_thread_canvas" TO "service_role";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."chat2_thread_canvas";
