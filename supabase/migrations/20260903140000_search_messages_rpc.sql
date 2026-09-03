-- Phase 3: compile the parsed query to SQL, once, here.
--
-- PERMISSIONS FIRST. This function is SECURITY INVOKER — the default, and stated
-- explicitly below so nobody "fixes" it later. That means every row it reads is filtered
-- by the messages_select policy in the same statement as the search: a private channel you
-- are not a member of cannot be reached through any argument, including in_channels naming
-- that channel directly or from_authors naming a member of it. There is no post-filter in
-- application code and no way for a caller to opt out, because the caller never gets to
-- write the SQL.
--
-- NO INTERPOLATION. Every value arrives as a typed parameter. The tsquery is built from
-- those parameters with plainto_tsquery / phraseto_tsquery / to_tsquery over a token this
-- function sanitises itself — never from a string the caller assembled.

CREATE OR REPLACE FUNCTION "public"."search_messages"(
  p_words           text[]      DEFAULT '{}',
  p_phrases         text[]      DEFAULT '{}',
  p_prefixes        text[]      DEFAULT '{}',
  p_exclude_words   text[]      DEFAULT '{}',
  p_exclude_phrases text[]      DEFAULT '{}',
  p_channels        uuid[]      DEFAULT '{}',
  p_exclude_channels uuid[]     DEFAULT '{}',
  p_authors         uuid[]      DEFAULT '{}',
  p_exclude_authors uuid[]      DEFAULT '{}',
  p_after           timestamptz DEFAULT NULL,
  p_before          timestamptz DEFAULT NULL,
  p_has             text[]      DEFAULT '{}',
  p_has_my          text[]      DEFAULT '{}',
  p_is              text[]      DEFAULT '{}',
  p_sort            text        DEFAULT 'relevance',
  p_limit           int         DEFAULT 20,
  p_cursor_rank     real        DEFAULT NULL,
  p_cursor_at       timestamptz DEFAULT NULL,
  p_cursor_id       uuid        DEFAULT NULL
)
RETURNS TABLE (
  id uuid, channel_id uuid, author_id uuid, created_at timestamptz,
  body text, snippet text, rank real
)
LANGUAGE plpgsql
SECURITY INVOKER              -- the whole permission model rests on this line
STABLE
SET search_path = public
AS $$
DECLARE
  v_query   tsquery := NULL;
  v_part    tsquery;
  v_token   text;
  v_limit   int := least(greatest(coalesce(p_limit, 20), 1), 100);
BEGIN
  -- words: every one must appear
  FOREACH v_token IN ARRAY coalesce(p_words, '{}') LOOP
    v_part := plainto_tsquery('english', v_token);
    IF v_part IS NOT NULL AND v_part != '' THEN
      v_query := CASE WHEN v_query IS NULL THEN v_part ELSE v_query && v_part END;
    END IF;
  END LOOP;
  -- phrases: in order, as a unit
  FOREACH v_token IN ARRAY coalesce(p_phrases, '{}') LOOP
    v_part := phraseto_tsquery('english', v_token);
    IF v_part IS NOT NULL AND v_part != '' THEN
      v_query := CASE WHEN v_query IS NULL THEN v_part ELSE v_query && v_part END;
    END IF;
  END LOOP;
  -- prefixes: to_tsquery is the only one that takes :*, so the token is stripped to
  -- alphanumerics here rather than trusted -- this is the one place a crafted string
  -- could otherwise reach the tsquery parser.
  FOREACH v_token IN ARRAY coalesce(p_prefixes, '{}') LOOP
    v_token := regexp_replace(lower(v_token), '[^a-z0-9]', '', 'g');
    IF length(v_token) >= 3 THEN
      v_part := to_tsquery('english', v_token || ':*');
      v_query := CASE WHEN v_query IS NULL THEN v_part ELSE v_query && v_part END;
    END IF;
  END LOOP;
  -- exclusions
  FOREACH v_token IN ARRAY coalesce(p_exclude_words, '{}') LOOP
    v_part := plainto_tsquery('english', v_token);
    IF v_part IS NOT NULL AND v_part != '' THEN
      v_query := CASE WHEN v_query IS NULL THEN !!v_part ELSE v_query && !!v_part END;
    END IF;
  END LOOP;
  FOREACH v_token IN ARRAY coalesce(p_exclude_phrases, '{}') LOOP
    v_part := phraseto_tsquery('english', v_token);
    IF v_part IS NOT NULL AND v_part != '' THEN
      v_query := CASE WHEN v_query IS NULL THEN !!v_part ELSE v_query && !!v_part END;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT m."id", m."channel_id", m."author_id", m."created_at", m."body",
         CASE WHEN v_query IS NULL THEN left(coalesce(m."body", ''), 200)
              ELSE ts_headline('english', coalesce(m."body", ''), v_query,
                     'StartSel=<mark>,StopSel=</mark>,MaxWords=24,MinWords=8,MaxFragments=2,FragmentDelimiter= … ')
         END AS snippet,
         -- relevance, then a gentle recency decay: a good match from last year should
         -- still lose to an equally good match from this morning.
         (CASE WHEN v_query IS NULL THEN 0.01
               ELSE ts_rank_cd(m."search_tsv", v_query) END
          * (1.0 / (1.0 + (extract(epoch FROM (now() - m."created_at")) / 2592000.0))::real)
         )::real AS rank
    FROM "public"."messages" m
   WHERE (v_query IS NULL OR m."search_tsv" @@ v_query)
     AND (cardinality(coalesce(p_channels, '{}')) = 0 OR m."channel_id" = ANY (p_channels))
     AND (cardinality(coalesce(p_exclude_channels, '{}')) = 0 OR NOT (m."channel_id" = ANY (p_exclude_channels)))
     AND (cardinality(coalesce(p_authors, '{}')) = 0 OR m."author_id" = ANY (p_authors))
     AND (cardinality(coalesce(p_exclude_authors, '{}')) = 0 OR NOT (m."author_id" = ANY (p_exclude_authors)))
     AND (p_after IS NULL OR m."created_at" >= p_after)
     AND (p_before IS NULL OR m."created_at" < p_before)
     -- has:/is: are facts about the message, checked by EXISTS against their own tables
     AND (NOT ('pin' = ANY (coalesce(p_has, '{}'))) OR m."pinned_at" IS NOT NULL)
     AND (NOT ('link' = ANY (coalesce(p_has, '{}'))) OR m."body" ~* 'https?://')
     AND (NOT ('file' = ANY (coalesce(p_has, '{}'))) OR EXISTS (
            SELECT 1 FROM "public"."message_attachments" a WHERE a."message_id" = m."id"))
     AND (NOT ('pinned' = ANY (coalesce(p_is, '{}'))) OR m."pinned_at" IS NOT NULL)
     AND (NOT ('thread' = ANY (coalesce(p_is, '{}'))) OR m."parent_id" IS NOT NULL
            OR coalesce(m."reply_count", 0) > 0)
     AND (cardinality(coalesce(p_has_my, '{}')) = 0 OR EXISTS (
            SELECT 1 FROM "public"."message_reactions" r
             WHERE r."message_id" = m."id" AND r."profile_id" = auth.uid()
               AND r."emoji" = ANY (SELECT btrim(unnest(p_has_my), ':'))))
     AND (cardinality(coalesce(p_has, '{}')) = 0 OR NOT EXISTS (
            SELECT 1 FROM unnest(p_has) h WHERE h LIKE ':%:')
          OR EXISTS (SELECT 1 FROM "public"."message_reactions" r
                      WHERE r."message_id" = m."id"
                        AND r."emoji" = ANY (SELECT btrim(unnest(p_has), ':'))))
     -- keyset pagination: strictly after the cursor, in whichever order was asked for
     AND (p_cursor_id IS NULL OR (
           CASE WHEN p_sort = 'newest' THEN (m."created_at", m."id") < (p_cursor_at, p_cursor_id)
                WHEN p_sort = 'oldest' THEN (m."created_at", m."id") > (p_cursor_at, p_cursor_id)
                ELSE ((CASE WHEN v_query IS NULL THEN 0.01
                            ELSE ts_rank_cd(m."search_tsv", v_query) END
                       * (1.0 / (1.0 + (extract(epoch FROM (now() - m."created_at")) / 2592000.0))::real)
                      )::real, m."id") < (p_cursor_rank, p_cursor_id)
           END))
   ORDER BY
     CASE WHEN p_sort = 'newest' THEN m."created_at" END DESC,
     CASE WHEN p_sort = 'oldest' THEN m."created_at" END ASC,
     CASE WHEN p_sort NOT IN ('newest','oldest') THEN
       (CASE WHEN v_query IS NULL THEN 0.01 ELSE ts_rank_cd(m."search_tsv", v_query) END
        * (1.0 / (1.0 + (extract(epoch FROM (now() - m."created_at")) / 2592000.0))::real))::real
     END DESC,
     m."id" DESC
   LIMIT v_limit;
END $$;

-- Counts for the tabs, in one round trip, under the same policy.
CREATE OR REPLACE FUNCTION "public"."search_messages_count"(
  p_words text[] DEFAULT '{}', p_phrases text[] DEFAULT '{}', p_prefixes text[] DEFAULT '{}',
  p_exclude_words text[] DEFAULT '{}', p_exclude_phrases text[] DEFAULT '{}',
  p_channels uuid[] DEFAULT '{}', p_exclude_channels uuid[] DEFAULT '{}',
  p_authors uuid[] DEFAULT '{}', p_exclude_authors uuid[] DEFAULT '{}',
  p_after timestamptz DEFAULT NULL, p_before timestamptz DEFAULT NULL,
  p_has text[] DEFAULT '{}', p_has_my text[] DEFAULT '{}', p_is text[] DEFAULT '{}'
) RETURNS bigint
LANGUAGE sql SECURITY INVOKER STABLE SET search_path = public AS $$
  SELECT count(*) FROM "public"."search_messages"(
    p_words, p_phrases, p_prefixes, p_exclude_words, p_exclude_phrases,
    p_channels, p_exclude_channels, p_authors, p_exclude_authors,
    p_after, p_before, p_has, p_has_my, p_is, 'newest', 100, NULL, NULL, NULL);
$$;

REVOKE ALL ON FUNCTION "public"."search_messages" FROM anon;
REVOKE ALL ON FUNCTION "public"."search_messages_count" FROM anon;
GRANT EXECUTE ON FUNCTION "public"."search_messages" TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."search_messages_count" TO authenticated;
