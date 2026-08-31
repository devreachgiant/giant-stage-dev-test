-- READ-ONLY. The five per-person views, and who is actually in each project.
DO $$
DECLARE r record;
BEGIN
  RAISE NOTICE 'per-person views:';
  FOR r IN SELECT v."name" vn, v."type"::text vt, COALESCE(v."mode",'?') vm,
                  p."name" pn, COALESCE(pr."full_name", pr."email", v."profile_id"::text) owner
             FROM "public"."project_views" v
             JOIN "public"."projects" p ON p."id" = v."project_id"
             LEFT JOIN "public"."profiles" pr ON pr."id" = v."profile_id"
            WHERE v."profile_id" IS NOT NULL LOOP
    RAISE NOTICE '   "%" (% / %) in project "%" -- owned by %', r.vn, r.vt, r.vm, r.pn, r.owner;
  END LOOP;

  RAISE NOTICE 'projects, members and assignees:';
  FOR r IN SELECT p."name" pn,
                  (SELECT count(*) FROM "public"."project_members" m WHERE m."project_id" = p."id") mem,
                  (SELECT count(*) FROM "public"."tasks" t WHERE t."project_id" = p."id") tasks,
                  (SELECT count(DISTINCT a) FROM "public"."tasks" t, unnest(t."assigned_to") a
                    WHERE t."project_id" = p."id") assignees,
                  (SELECT count(*) FROM "public"."tasks" t WHERE t."project_id" = p."id"
                     AND cardinality(t."assigned_to") = 0) unassigned
             FROM "public"."projects" p ORDER BY 3 DESC LOOP
    RAISE NOTICE '   % | % members | % tasks | % distinct assignees | % unassigned', r.pn, r.mem, r.tasks, r.assignees, r.unassigned;
  END LOOP;
END $$;
