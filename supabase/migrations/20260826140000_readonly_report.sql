-- Placeholder for a read-only report that was run against production on 2026-08-26 while
-- investigating duplicate department channels. It queried; it changed nothing -- no table,
-- column, policy or row was touched.
--
-- It is recorded here because the remote migration history has the version and the CLI
-- refuses to push while local and remote disagree. The file is deliberately empty of
-- effect: re-running it must do nothing, which is exactly what the original did to the
-- schema.

SELECT 1 WHERE false;
