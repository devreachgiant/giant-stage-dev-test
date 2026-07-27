-- Completes the "everyone can post in Home" change: a plain member couldn't
-- even SELECT the chat2_threads row for kind='home' to discover its id (the
-- prior chat2_threads_select policy required manager/owner or existing
-- membership) — meaning the self-join policy added in the previous migration
-- was unreachable in practice. The Home thread row itself is not sensitive
-- (no client data), so it's safe to make visible to every authenticated user.

CREATE POLICY "chat2_threads_select_home_anyone" ON "public"."chat2_threads" FOR SELECT TO "authenticated"
    USING ("kind" = 'home');
