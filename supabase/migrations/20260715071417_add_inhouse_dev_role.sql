-- New role: inhouse_dev — full parity with owner/manager everywhere in the app, for internal
-- developers/testers who shouldn't have their profile relabeled "owner"/"manager".
-- Split into its own migration: Postgres won't let a newly-added enum value be used
-- (e.g. in an UPDATE) within the same transaction it was added in.

ALTER TYPE "public"."user_role" ADD VALUE 'inhouse_dev';
