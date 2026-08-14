-- Team channel colored dots for Chat 3.0's Teams list (Google Ads/SEO/Meta/Web/
-- Design/Content/Management). The existing 4-entry DEPTS palette only covers
-- client-department colors, not team-channel names — this is a free-text hex
-- column set from a swatch picker, same pattern as projects.color.

ALTER TABLE "public"."chat2_threads" ADD COLUMN IF NOT EXISTS "color" text NULL;
