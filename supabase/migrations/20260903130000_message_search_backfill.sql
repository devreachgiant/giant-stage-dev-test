-- Phase 2 backfill: fills search_tsv for every row that existed before the trigger.
--
-- Batched, and it reports as it goes. Done in SQL rather than over the API on purpose:
-- the first attempt PATCHed one row at a time to fire the trigger, which is 12,396 HTTP
-- round trips and had not finished after ten minutes. Here it is one statement per batch,
-- next to the data.
--
-- Batches rather than one UPDATE so the table is not locked for the whole rewrite while
-- people are using chat, and so an interrupted run leaves finished batches finished --
-- it always asks for the next unindexed rows rather than walking an offset.

DO $$
DECLARE
  v_batch  int := 2000;
  v_done   int := 0;
  v_rows    int;
  v_left    int;
BEGIN
  SELECT count(*) INTO v_left FROM "public"."messages" WHERE "search_tsv" IS NULL;
  RAISE NOTICE 'backfill: % messages need indexing', v_left;

  LOOP
    WITH batch AS (
      SELECT "id", "body" FROM "public"."messages"
       WHERE "search_tsv" IS NULL
       LIMIT v_batch
    )
    UPDATE "public"."messages" m
       SET "search_tsv" = setweight(to_tsvector('english', coalesce(b."body", '')), 'B')
      FROM batch b
     WHERE m."id" = b."id";
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXIT WHEN v_rows = 0;
    v_done := v_done + v_rows;
    RAISE NOTICE 'backfill: % indexed', v_done;
  END LOOP;

  SELECT count(*) INTO v_left FROM "public"."messages" WHERE "search_tsv" IS NULL;
  RAISE NOTICE 'backfill: complete, % rows still unindexed', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'backfill left % rows unindexed', v_left;
  END IF;
END $$;

ANALYZE "public"."messages";
