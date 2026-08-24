-- The Members matrix in New Chat ticks four things that are not departments:
-- Onboarding, Deliverables, Tasks and Billing. Everything ticked there until now was a
-- `channel_members` row against one of the client's department channels, which works
-- because a department IS a channel. These four are not. They are areas of the client
-- record, so there was nowhere to write them and nothing to read back.
--
-- A separate table rather than more columns on channel_members, for the obvious reason:
-- these grants have no channel to hang off. A client can have a Billing grant and no
-- channels at all.
--
-- 'deliverables' is included even though New Chat has no Deliverables surface yet. The
-- permission is being recorded now so the grant exists when the surface does; a tick
-- that persists and gates nothing is honest, where a tick that does not persist is not.

CREATE TABLE IF NOT EXISTS "public"."client_member_areas" (
  "client_id"  uuid NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
  -- Checked rather than free text: the UI renders a fixed set of columns, and a typo'd
  -- area would store a grant that nothing ever reads, which is worse than a failed write.
  "area"       text NOT NULL CHECK ("area" IN ('onboarding', 'deliverables', 'tasks', 'billing')),
  "granted_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("client_id", "profile_id", "area")
);

ALTER TABLE "public"."client_member_areas" ENABLE ROW LEVEL SECURITY;

-- Read: managers, owners and in-house devs see the whole matrix, because that is the
-- screen. Everyone else sees only their own grants -- a member needs to know what they
-- can open, and the client-side gate reads this table to decide. It deliberately does
-- not let one member enumerate another's access.
DROP POLICY IF EXISTS "client_member_areas_select" ON "public"."client_member_areas";
CREATE POLICY "client_member_areas_select" ON "public"."client_member_areas" FOR SELECT
  USING (public.is_manager_or_owner() OR "profile_id" = auth.uid());

-- Write: managers only, and never on your own behalf by accident -- granted_by is
-- recorded so the Activity trail can say who opened what up.
DROP POLICY IF EXISTS "client_member_areas_insert" ON "public"."client_member_areas";
CREATE POLICY "client_member_areas_insert" ON "public"."client_member_areas" FOR INSERT
  WITH CHECK (public.is_manager_or_owner());

DROP POLICY IF EXISTS "client_member_areas_delete" ON "public"."client_member_areas";
CREATE POLICY "client_member_areas_delete" ON "public"."client_member_areas" FOR DELETE
  USING (public.is_manager_or_owner());

-- The matrix loads by client, and the per-member gate loads by profile. Both are hot
-- enough on this screen to be worth an index each.
CREATE INDEX IF NOT EXISTS "client_member_areas_client_idx"
  ON "public"."client_member_areas" ("client_id");
CREATE INDEX IF NOT EXISTS "client_member_areas_profile_idx"
  ON "public"."client_member_areas" ("profile_id");
