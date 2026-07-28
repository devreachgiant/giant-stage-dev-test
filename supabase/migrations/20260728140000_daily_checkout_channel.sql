-- New channel for real end-of-day reports (the End of Day modal previously posted nowhere
-- despite claiming to — see index.html Team Pulse changes in this same deploy).
INSERT INTO "public"."channels" ("name", "slug", "description", "is_private", "position")
SELECT 'daily-checkout', 'daily-checkout', 'End-of-day reports from the team', false, 5
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."channels" WHERE "slug" = 'daily-checkout' OR "name" = 'daily-checkout'
);
