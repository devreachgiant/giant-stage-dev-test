-- "Remove" a team member (manage-member.js -> Supabase Auth Admin API DELETE
-- /admin/users/:id) has been failing with a generic "Database error deleting
-- user" 500 for every user with any real data, e.g. Gel: profiles.id is
-- ON DELETE CASCADE from auth.users, and dozens of app tables cascade or
-- SET NULL further from profiles.id — but supabase_auth_admin (the role
-- GoTrue's Admin API runs as) had zero grants on ANY public schema table,
-- confirmed via has_table_privilege('supabase_auth_admin', 'public.profiles',
-- 'DELETE') = false. Postgres requires the deleting role itself to hold the
-- privilege on every table touched by a cascade/set-null chain, so the whole
-- auth.users delete was rejected with a permission error before it ever got
-- anywhere near the NOT-NULL/SET-NULL contradictions fixed earlier today.
--
-- Grants full DML (not DDL) on the public schema to supabase_auth_admin, plus
-- default privileges so future tables (e.g. new chat2_*/white_label_* tables)
-- don't silently reopen this same bug.

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO supabase_auth_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO supabase_auth_admin;
