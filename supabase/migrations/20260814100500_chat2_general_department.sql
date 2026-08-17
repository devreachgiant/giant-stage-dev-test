-- Chat 3.0 adds a "General" tab alongside the 4 ad-platform departments per client
-- (not tied to Google Ads/Meta/SEO/Web specifically) — needs its own department
-- value so it gets its own client_dept thread like the others.

ALTER TABLE "public"."chat2_threads" DROP CONSTRAINT IF EXISTS "chat2_threads_department_check";
ALTER TABLE "public"."chat2_threads" ADD CONSTRAINT "chat2_threads_department_check"
    CHECK ("department" IN ('general', 'googleAds', 'metaAds', 'seo', 'web'));
