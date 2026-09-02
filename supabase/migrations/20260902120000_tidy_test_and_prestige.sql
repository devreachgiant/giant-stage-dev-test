-- Two pieces of tidying, asked for explicitly:
--   1. delete the leftover test client CHANNELS
--   2. merge the three Prestige Lighting records down to the one with the conversation
--
-- Everything here refuses rather than guesses. No channel carrying a single message is
-- touched; the merge moves what references the duplicate before removing it, and raises
-- if anything is left pointing at it.
--
-- Deliberately NOT done: deleting the test CLIENT records. Two of them turned out to
-- carry real work -- "Test Client Co" has 2 tasks and 5 time sessions, "test" has 1 task
-- and 19 time sessions -- so removing them would take that with it. Channels only.

DO $$
DECLARE
  v_keep   uuid := 'cd31eaaa-da94-43f4-8e72-213366bf8483';  -- "Prestige Lighting Co." — 46 messages
  v_dup1   uuid := 'ab119961-8945-4938-98f6-06734da0804f';  -- "Prestige Lighting Co"  — 4 empty channels
  v_dup2   uuid := 'ed7520f7-a283-4142-bd49-088a44e5bbe9';  -- "Prestige Lighting CO"  — nothing at all
  v_ch     record;
  v_n      int;
  v_killed int := 0;
BEGIN
  -- ── the channel the merge keeps must actually be the one with the history ──────
  SELECT count(*) INTO v_n
    FROM "public"."messages" m
    JOIN "public"."channels" c ON c."id" = m."channel_id"
   WHERE c."client_id" = v_keep;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'The Prestige record being kept has no messages - refusing to merge into it';
  END IF;

  -- ── every channel about to be deleted must be empty ───────────────────────────
  FOR v_ch IN
    SELECT c."id", c."name"
      FROM "public"."channels" c
     WHERE c."client_id" IN (v_dup1, v_dup2)
        OR (c."kind" = 'client_dept' AND c."client_id" IN (
              SELECT "id" FROM "public"."clients"
               WHERE lower(btrim("name")) IN ('test', 'test client co', 'wizard test client')))
  LOOP
    SELECT count(*) INTO v_n FROM "public"."messages" WHERE "channel_id" = v_ch."id";
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Channel % has % message(s) - refusing to delete it', v_ch."name", v_n;
    END IF;
    DELETE FROM "public"."channels" WHERE "id" = v_ch."id";
    v_killed := v_killed + 1;
  END LOOP;
  RAISE NOTICE 'Deleted % empty channel(s)', v_killed;

  -- ── move what the duplicate Prestige still carries onto the one being kept ─────
  UPDATE "public"."time_sessions" SET "client_id" = v_keep WHERE "client_id" IN (v_dup1, v_dup2);
  UPDATE "public"."tasks"         SET "client_id" = v_keep WHERE "client_id" IN (v_dup1, v_dup2);
  UPDATE "public"."invoices"      SET "client_id" = v_keep WHERE "client_id" IN (v_dup1, v_dup2);

  -- ── and only then remove the duplicates, if nothing is left pointing at them ───
  SELECT count(*) INTO v_n FROM "public"."channels" WHERE "client_id" IN (v_dup1, v_dup2);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Duplicate Prestige records still have % channel(s) - refusing to delete', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM "public"."time_sessions" WHERE "client_id" IN (v_dup1, v_dup2);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Duplicate Prestige records still have % time session(s) - refusing to delete', v_n;
  END IF;

  DELETE FROM "public"."clients" WHERE "id" IN (v_dup1, v_dup2);
  RAISE NOTICE 'Prestige merged into %', v_keep;
END $$;
