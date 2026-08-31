-- READ-ONLY. What Projects actually looks like in production, so "fewer view types" is
-- chosen from evidence rather than taste. No DDL, no DML, only RAISE NOTICE.

DO $$
DECLARE r record; v int;
BEGIN
  SELECT count(*) INTO v FROM "public"."projects";
  RAISE NOTICE 'projects: % total', v;
  FOR r IN SELECT COALESCE("status",'(null)') AS s, count(*) c FROM "public"."projects" GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '   status %: %', r.s, r.c;
  END LOOP;
  SELECT count(*) INTO v FROM "public"."projects" WHERE "client_id" IS NOT NULL;
  RAISE NOTICE '   attached to a client: %', v;

  SELECT count(*) INTO v FROM "public"."tasks";
  RAISE NOTICE 'tasks: % total', v;
  SELECT count(*) INTO v FROM "public"."tasks" WHERE "view_id" IS NOT NULL;
  RAISE NOTICE '   with a view_id set: %', v;

  RAISE NOTICE 'project_views by type:';
  FOR r IN SELECT "type"::text t, count(*) c, count(DISTINCT "project_id") p, count(DISTINCT "profile_id") u
             FROM "public"."project_views" GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '   % : % views across % projects, % distinct owners', r.t, r.c, r.p, r.u;
  END LOOP;
  RAISE NOTICE 'project_views by mode:';
  FOR r IN SELECT COALESCE("mode",'(null)') m, count(*) c FROM "public"."project_views" GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '   % : %', r.m, r.c;
  END LOOP;
  SELECT count(*) INTO v FROM "public"."project_views" WHERE "profile_id" IS NOT NULL;
  RAISE NOTICE '   views owned by a person (per-user): %', v;
  SELECT count(*) INTO v FROM "public"."project_views" WHERE "profile_id" IS NULL;
  RAISE NOTICE '   views with no owner (already shared): %', v;
  SELECT count(*) INTO v FROM "public"."project_views" WHERE "sections" IS NOT NULL AND "sections"::text <> '[]';
  RAISE NOTICE '   views using sections: %', v;

  SELECT count(*) INTO v FROM "public"."project_fields";
  RAISE NOTICE 'custom fields: % across % projects', v, (SELECT count(DISTINCT "project_id") FROM "public"."project_fields");
  RAISE NOTICE 'priority chips by kind:';
  FOR r IN SELECT "kind", count(*) c FROM "public"."project_priorities" GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '   % : %', r."kind", r.c;
  END LOOP;

  RAISE NOTICE 'busiest projects:';
  FOR r IN SELECT p."name", count(t."id") c FROM "public"."projects" p
             LEFT JOIN "public"."tasks" t ON t."project_id" = p."id"
            GROUP BY p."id", p."name" ORDER BY 2 DESC LIMIT 8 LOOP
    RAISE NOTICE '   % : % tasks', r."name", r.c;
  END LOOP;
END $$;
