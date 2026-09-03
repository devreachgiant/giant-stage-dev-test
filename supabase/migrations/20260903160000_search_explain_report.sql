-- Read-only. Runs EXPLAIN ANALYZE on the three query shapes the brief asks about and
-- prints the plans as notices. Changes nothing; kept in the history so the numbers are
-- reproducible rather than a screenshot in a chat message.
DO $$
DECLARE
  v_line text;
  v_q tsquery := plainto_tsquery('english', 'report');
  v_chan uuid;
  v_author uuid;
BEGIN
  SELECT "channel_id" INTO v_chan FROM "public"."messages" GROUP BY "channel_id"
   ORDER BY count(*) DESC LIMIT 1;
  SELECT "author_id" INTO v_author FROM "public"."messages" GROUP BY "author_id"
   ORDER BY count(*) DESC LIMIT 1;

  RAISE NOTICE '=== 1. free text, ranked (the common case) ===';
  FOR v_line IN
    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, TIMING) SELECT id, ts_rank_cd(search_tsv, $1) r
               FROM messages WHERE search_tsv @@ $1 ORDER BY r DESC, id DESC LIMIT 20'
    USING v_q
  LOOP RAISE NOTICE '%', v_line; END LOOP;

  RAISE NOTICE '=== 2. free text + in:channel + date range ===';
  FOR v_line IN
    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, TIMING) SELECT id FROM messages
              WHERE search_tsv @@ $1 AND channel_id = $2
                AND created_at >= now() - interval ''365 days''
              ORDER BY created_at DESC, id DESC LIMIT 20'
    USING v_q, v_chan
  LOOP RAISE NOTICE '%', v_line; END LOOP;

  RAISE NOTICE '=== 3. no free text, from: only (filters alone, the worst shape) ===';
  FOR v_line IN
    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, TIMING) SELECT id FROM messages
              WHERE author_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20'
    USING v_author
  LOOP RAISE NOTICE '%', v_line; END LOOP;
END $$;
