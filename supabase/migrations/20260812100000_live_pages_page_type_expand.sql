-- live_pages_page_type_check only allowed the original 4 page types, silently blocking
-- Publish for seo_audit/geo_audit/google_ads_audit (already in the UI) and the new
-- match_text type with a constraint violation. Expand it to match every page type
-- the Templates UI actually offers.
alter table public.live_pages
  drop constraint if exists live_pages_page_type_check;

alter table public.live_pages
  add constraint live_pages_page_type_check
  check (page_type = ANY (ARRAY[
    'landing'::text,
    'report'::text,
    'website_proposal'::text,
    'marketing_proposal'::text,
    'seo_audit'::text,
    'geo_audit'::text,
    'google_ads_audit'::text,
    'match_text'::text
  ]));
