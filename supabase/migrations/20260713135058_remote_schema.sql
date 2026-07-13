


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."client_status" AS ENUM (
    'active',
    'onboarding',
    'at_risk',
    'paused',
    'churned'
);


ALTER TYPE "public"."client_status" OWNER TO "postgres";


CREATE TYPE "public"."invoice_status" AS ENUM (
    'draft',
    'open',
    'paid',
    'overdue',
    'void',
    'uncollectible'
);


ALTER TYPE "public"."invoice_status" OWNER TO "postgres";


CREATE TYPE "public"."session_status" AS ENUM (
    'running',
    'paused',
    'completed',
    'abandoned'
);


ALTER TYPE "public"."session_status" OWNER TO "postgres";


CREATE TYPE "public"."task_priority" AS ENUM (
    'fire',
    'medium',
    'low'
);


ALTER TYPE "public"."task_priority" OWNER TO "postgres";


CREATE TYPE "public"."task_status" AS ENUM (
    'todo',
    'in_progress',
    'done',
    'blocked'
);


ALTER TYPE "public"."task_status" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'owner',
    'manager',
    'member',
    'client'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE TYPE "public"."user_status" AS ENUM (
    'online',
    'focus',
    'meeting',
    'away',
    'offline'
);


ALTER TYPE "public"."user_status" OWNER TO "postgres";


CREATE TYPE "public"."view_type" AS ENUM (
    'daily',
    'weekly',
    'backlog',
    'board',
    'custom'
);


ALTER TYPE "public"."view_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_all_members_to_channel"("p_channel_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.channel_members (channel_id, profile_id)
  select p_channel_id, pr.id
  from public.profiles pr
  where not exists (
    select 1 from public.channel_members cm
    where cm.channel_id = p_channel_id and cm.profile_id = pr.id
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."add_all_members_to_channel"("p_channel_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_manage_project"("p_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.created_by = auth.uid()
  ) or exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.role in ('owner','manager')
  );
$$;


ALTER FUNCTION "public"."can_manage_project"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_group_dm"("p_member_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_channel uuid;
  v_me uuid := auth.uid();
  v_all uuid[];
  v_name text;
  v_slug text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  -- distinct members including me
  v_all := (select array_agg(distinct x) from unnest(array_append(p_member_ids, v_me)) as x where x is not null);
  if coalesce(array_length(v_all,1),0) < 3 then
    raise exception 'a group needs at least 3 members';
  end if;
  -- name from the other members' first names
  select string_agg(split_part(coalesce(pr.full_name, pr.email, '?'), ' ', 1), ', ')
    into v_name
    from public.profiles pr
    where pr.id = any(p_member_ids) and pr.id <> v_me;
  v_slug := 'group-' || replace(gen_random_uuid()::text, '-', '');
  insert into public.channels (name, slug, is_dm, is_group, is_private, created_by)
    values (coalesce(nullif(v_name,''),'Group'), v_slug, true, true, true, v_me)
    returning id into v_channel;
  insert into public.channel_members (channel_id, profile_id)
    select v_channel, x from unnest(v_all) as x;
  return v_channel;
end;
$$;


ALTER FUNCTION "public"."create_group_dm"("p_member_ids" "uuid"[]) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."invitations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "role" "public"."user_role" DEFAULT 'member'::"public"."user_role" NOT NULL,
    "token" "text" NOT NULL,
    "invited_by" "uuid",
    "invite_method" "text" DEFAULT 'password'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    "accepted_by" "uuid",
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invitations" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_invitation"("p_email" "text", "p_role" "public"."user_role" DEFAULT 'member'::"public"."user_role", "p_full_name" "text" DEFAULT NULL::"text", "p_invite_method" "text" DEFAULT 'password'::"text") RETURNS "public"."invitations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inviter_role user_role; v_existing public.invitations%ROWTYPE;
  v_token text; v_row public.invitations%ROWTYPE;
BEGIN
  v_inviter_role := public.current_role();
  IF v_inviter_role IS NULL OR v_inviter_role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'Only owners and managers can invite users';
  END IF;
  IF v_inviter_role = 'manager' AND p_role <> 'member' THEN
    RAISE EXCEPTION 'Managers can only invite members';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'This email already belongs to a workspace member';
  END IF;

  SELECT * INTO v_existing FROM public.invitations
   WHERE lower(email) = lower(p_email) AND accepted_at IS NULL
     AND revoked_at IS NULL AND expires_at > now() LIMIT 1;
  IF FOUND THEN
    UPDATE public.invitations
       SET expires_at = now() + interval '7 days',
           role = p_role, full_name = COALESCE(p_full_name, full_name),
           invite_method = p_invite_method
     WHERE id = v_existing.id RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  v_token := public.generate_invitation_token();
  INSERT INTO public.invitations (email, full_name, role, token, invited_by, invite_method)
  VALUES (lower(p_email), p_full_name, p_role, v_token, auth.uid(), p_invite_method)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;


ALTER FUNCTION "public"."create_invitation"("p_email" "text", "p_role" "public"."user_role", "p_full_name" "text", "p_invite_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_role"() RETURNS "public"."user_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;


ALTER FUNCTION "public"."current_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_client_link"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT client_link_id FROM public.profiles WHERE id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_client_link"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dm_pair_key"("a" "uuid", "b" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
BEGIN
  IF a::text < b::text THEN
    RETURN a::text || '_' || b::text;
  ELSE
    RETURN b::text || '_' || a::text;
  END IF;
END $$;


ALTER FUNCTION "public"."dm_pair_key"("a" "uuid", "b" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_dm_channel"("other_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  me uuid := auth.uid();
  pair_key text;
  existing_id uuid;
  new_id uuid;
  me_name text;
  other_name text;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF other_id = me THEN
    RAISE EXCEPTION 'Cannot DM yourself';
  END IF;
  pair_key := dm_pair_key(me, other_id);
  -- Check if a DM channel already exists for this pair
  SELECT id INTO existing_id FROM channels WHERE dm_pair = pair_key LIMIT 1;
  IF existing_id IS NOT NULL THEN
    -- Make sure both members are in channel_members
    INSERT INTO channel_members (channel_id, profile_id) VALUES (existing_id, me) ON CONFLICT DO NOTHING;
    INSERT INTO channel_members (channel_id, profile_id) VALUES (existing_id, other_id) ON CONFLICT DO NOTHING;
    RETURN existing_id;
  END IF;
  -- Get names for the channel name
  SELECT COALESCE(full_name, email) INTO me_name FROM profiles WHERE id = me;
  SELECT COALESCE(full_name, email) INTO other_name FROM profiles WHERE id = other_id;
  -- Create new DM channel
  INSERT INTO channels (name, slug, is_private, is_dm, dm_pair, created_by)
  VALUES (
    COALESCE(other_name, 'DM'),
    'dm-' || substring(pair_key, 1, 12) || '-' || substring(md5(random()::text), 1, 5),
    true, true, pair_key, me
  )
  RETURNING id INTO new_id;
  -- Add both members
  INSERT INTO channel_members (channel_id, profile_id) VALUES (new_id, me);
  INSERT INTO channel_members (channel_id, profile_id) VALUES (new_id, other_id);
  RETURN new_id;
END $$;


ALTER FUNCTION "public"."ensure_dm_channel"("other_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_invitation_token"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE v_token text; v_attempts int := 0;
BEGIN
  LOOP
    v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.invitations WHERE token = v_token);
    v_attempts := v_attempts + 1;
    IF v_attempts > 5 THEN RAISE EXCEPTION 'Could not generate unique token'; END IF;
  END LOOP;
  RETURN v_token;
END $$;


ALTER FUNCTION "public"."generate_invitation_token"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_invoice_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  next_n integer;
BEGIN
  IF NEW.number IS NULL OR NEW.number = '' THEN
    SELECT COALESCE(MAX(CAST(SUBSTRING(number FROM 'INV-(\d+)') AS integer)), 0) + 1 INTO next_n
    FROM public.invoices WHERE number ~ '^INV-\d+$';
    NEW.number := 'INV-' || LPAD(next_n::text, 4, '0');
  END IF;
  RETURN NEW;
END $_$;


ALTER FUNCTION "public"."generate_invoice_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_onboarding_token"("p_client_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_token text;
BEGIN
  -- Generate a 32-char URL-safe token
  v_token := encode(gen_random_bytes(24), 'base64');
  -- Make URL-safe (strip +/= and replace with -_)
  v_token := translate(v_token, '+/=', '-_');
  UPDATE public.clients SET onboarding_token = v_token, onboarding_sent_at = now() WHERE id = p_client_id;
  RETURN v_token;
END $$;


ALTER FUNCTION "public"."generate_onboarding_token"("p_client_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_secret"("p_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_value text;
BEGIN
  SELECT decrypted_secret INTO v_value FROM vault.decrypted_secrets WHERE name = p_name LIMIT 1;
  RETURN v_value;
END $$;


ALTER FUNCTION "public"."get_secret"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."giant_can_invite"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('owner','manager')
  );
$$;


ALTER FUNCTION "public"."giant_can_invite"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_profile_join_channels"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.channel_members (channel_id, profile_id)
  SELECT c.id, NEW.id FROM public.channels c
  WHERE c.is_private = false AND c.is_dm = false
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."handle_new_profile_join_channels"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_public_channel"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.is_private = false AND NEW.is_dm = false THEN
    INSERT INTO public.channel_members (channel_id, profile_id)
    SELECT NEW.id, p.id FROM public.profiles p
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."handle_new_public_channel"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_profile_count integer;
  v_invited_role  user_role;
  v_invitation_id uuid;
  v_full_name     text;
  v_is_admin_invite boolean;
BEGIN
  SELECT count(*) INTO v_profile_count FROM public.profiles;
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1));

  -- First user ever → owner
  IF v_profile_count = 0 THEN
    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (NEW.id, NEW.email, v_full_name, 'owner');
    RETURN NEW;
  END IF;

  -- Invitation-based signup (Giant flow)
  SELECT id, role INTO v_invitation_id, v_invited_role
    FROM public.invitations
   WHERE lower(email) = lower(NEW.email)
     AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1;

  IF v_invitation_id IS NOT NULL THEN
    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (NEW.id, NEW.email, v_full_name, v_invited_role);
    UPDATE public.invitations SET accepted_at = now(), accepted_by = NEW.id
     WHERE id = v_invitation_id;
    RETURN NEW;
  END IF;

  -- Admin-issued Supabase Auth invite (no public self-signup possible):
  -- a Supabase "invite user" sets invited_at on the auth.users row.
  v_is_admin_invite := (NEW.invited_at IS NOT NULL);

  IF v_is_admin_invite THEN
    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (NEW.id, NEW.email, v_full_name, 'member');
    RETURN NEW;
  END IF;

  -- Otherwise: still closed to the public
  RAISE EXCEPTION USING
    MESSAGE = 'Signup is closed. You need an invitation to join this workspace.',
    ERRCODE = 'insufficient_privilege';
END $$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_thread_reply"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_id IS NOT NULL THEN
    UPDATE public.messages
       SET reply_count = reply_count + 1,
           last_reply_at = NEW.created_at
     WHERE id = NEW.parent_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_id IS NOT NULL THEN
    UPDATE public.messages
       SET reply_count = GREATEST(reply_count - 1, 0)
     WHERE id = OLD.parent_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;


ALTER FUNCTION "public"."handle_thread_reply"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_workspace_files_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_workspace_files_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_client_user"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role::text = 'client'
  );
$$;


ALTER FUNCTION "public"."is_client_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_manager_or_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT public.current_role() IN ('owner','manager')
$$;


ALTER FUNCTION "public"."is_manager_or_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT public.current_role() = 'owner'
$$;


ALTER FUNCTION "public"."is_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_project_member"("p_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.created_by = auth.uid()
  ) or exists (
    select 1 from public.project_members m
    where m.project_id = p_project_id and m.profile_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_project_member"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_project_owner"("p_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = p_project_id AND created_by = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_project_owner"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lookup_invitation"("p_token" "text") RETURNS TABLE("id" "uuid", "email" "text", "full_name" "text", "role" "public"."user_role", "is_valid" boolean, "reason" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_inv public.invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE token = p_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, NULL::user_role, false, 'not_found'::text; RETURN;
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT v_inv.id, v_inv.email, v_inv.full_name, v_inv.role, false, 'already_accepted'::text; RETURN;
  END IF;
  IF v_inv.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT v_inv.id, v_inv.email, v_inv.full_name, v_inv.role, false, 'revoked'::text; RETURN;
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN QUERY SELECT v_inv.id, v_inv.email, v_inv.full_name, v_inv.role, false, 'expired'::text; RETURN;
  END IF;
  RETURN QUERY SELECT v_inv.id, v_inv.email, v_inv.full_name, v_inv.role, true, 'valid'::text;
END $$;


ALTER FUNCTION "public"."lookup_invitation"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_invitation"("p_id" "uuid") RETURNS "public"."invitations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_row public.invitations%ROWTYPE;
BEGIN
  IF NOT public.is_manager_or_owner() THEN
    RAISE EXCEPTION 'Only owners and managers can revoke invitations';
  END IF;
  UPDATE public.invitations
     SET revoked_at = now(), revoked_by = auth.uid()
   WHERE id = p_id AND accepted_at IS NULL
     AND (public.is_owner() OR invited_by = auth.uid())
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found or already accepted/revoked'; END IF;
  RETURN v_row;
END $$;


ALTER FUNCTION "public"."revoke_invitation"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_invitation_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_resend_key text; v_app_url text; v_from text;
  v_inviter text; v_workspace text;
  v_accept_url text; v_subject text; v_html text; v_expires_fmt text;
  v_request_id bigint;
BEGIN
  v_resend_key := public.get_secret('resend_api_key');
  v_app_url    := COALESCE(public.get_secret('app_url'), 'https://app.giant.tools');
  v_from       := COALESCE(public.get_secret('resend_from'), 'Giant <notifications@giant.tools>');
  v_workspace  := COALESCE(public.get_secret('workspace_name'), 'Giant');

  IF v_resend_key IS NULL THEN
    RAISE WARNING 'resend_api_key not configured in Vault — email skipped';
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_inviter FROM public.profiles WHERE id = NEW.invited_by;
  v_inviter := COALESCE(v_inviter, 'A teammate');
  v_accept_url := v_app_url || '/accept-invite?token=' || NEW.token;
  v_expires_fmt := to_char(NEW.expires_at, 'FMMonth DD, YYYY');
  v_subject := v_inviter || ' invited you to ' || v_workspace;

  v_html :=
'<!DOCTYPE html><html><body style="margin:0;padding:0;background:#070707;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#fff;">'
||'<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#070707;padding:40px 20px;"><tr><td align="center">'
||'<table cellpadding="0" cellspacing="0" border="0" width="540" style="max-width:540px;background:#0D0D0D;border:1px solid #1E1E1E;border-radius:14px;">'
||'<tr><td style="padding:28px 32px 20px;border-bottom:1px solid #1E1E1E;"><table><tr>'
||'<td><div style="display:inline-block;width:30px;height:30px;background:#D00400;border-radius:7px;text-align:center;line-height:30px;color:#fff;font-weight:800;font-size:14px;">G</div></td>'
||'<td style="padding-left:11px;"><span style="font-size:15px;font-weight:800;color:#fff;">'||v_workspace||'</span></td>'
||'</tr></table></td></tr>'
||'<tr><td style="padding:36px 32px 28px;">'
||'<h1 style="margin:0 0 14px;font-size:22px;font-weight:800;color:#fff;">You''ve been invited to '||v_workspace||'</h1>'
||'<p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#A8A8A8;"><span style="color:#fff;font-weight:600;">'||v_inviter||'</span> has invited you to join as <span style="color:#fff;font-weight:600;">'||NEW.role::text||'</span>.</p>'
||'<table><tr><td style="background:#D00400;border-radius:9px;"><a href="'||v_accept_url||'" style="display:inline-block;padding:13px 26px;font-size:13.5px;font-weight:700;color:#fff;text-decoration:none;">Accept invitation →</a></td></tr></table>'
||'<p style="margin:24px 0 0;font-size:12px;color:#5C5C5F;">This invitation expires on '||v_expires_fmt||'.</p>'
||'<p style="margin:24px 0 0;font-size:11px;color:#5C5C5F;word-break:break-all;">Or paste this link: <a href="'||v_accept_url||'" style="color:#A8A8A8;">'||v_accept_url||'</a></p>'
||'</td></tr>'
||'<tr><td style="padding:18px 32px 24px;border-top:1px solid #1E1E1E;font-size:11px;color:#5C5C5F;text-align:center;">© '||extract(year from now())::text||' '||v_workspace||'</td></tr>'
||'</table></td></tr></table></body></html>';

  SELECT net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_resend_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(NEW.email), 'subject', v_subject, 'html', v_html)
  ) INTO v_request_id;

  RETURN NEW;
END $$;


ALTER FUNCTION "public"."send_invitation_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at_live_pages"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."set_updated_at_live_pages"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_notification_prefs_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_notification_prefs_timestamp"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_conversations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "title" "text" DEFAULT 'New chat'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "folder_id" "uuid",
    "client_id" "uuid"
);


ALTER TABLE "public"."ai_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_folders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_messages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."ai_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "event_type_id" "uuid" NOT NULL,
    "host_profile_id" "uuid" NOT NULL,
    "guest_name" "text" NOT NULL,
    "guest_email" "text" NOT NULL,
    "guest_notes" "text",
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "timezone" "text" DEFAULT 'Europe/Paris'::"text",
    "status" "text" DEFAULT 'confirmed'::"text",
    "cancel_reason" "text",
    "meeting_link" "text",
    "reminder_sent" boolean DEFAULT false,
    "cal_event_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cancel_token" "text",
    "rescheduled_from_id" "uuid",
    "questions_answers" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."brand_kits" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Default kit'::"text" NOT NULL,
    "color_primary" "text",
    "color_secondary" "text",
    "color_accent" "text",
    "color_background" "text",
    "color_text" "text",
    "font_headline" "text",
    "font_body" "text",
    "tone" "text",
    "voice_notes" "text",
    "logo_data_url" "text",
    "logo_mime" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "inspirations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "products" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."brand_kits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "gcal_event_id" "text",
    "calendar_id" "text" DEFAULT 'primary'::"text",
    "title" "text" NOT NULL,
    "description" "text",
    "location" "text",
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "all_day" boolean DEFAULT false,
    "status" "text" DEFAULT 'confirmed'::"text",
    "attendees" "jsonb" DEFAULT '[]'::"jsonb",
    "meeting_link" "text",
    "color" "text",
    "source" "text" DEFAULT 'google'::"text",
    "booking_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."channel_canvas" (
    "channel_id" "uuid" NOT NULL,
    "content" "text",
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."channel_canvas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."channel_members" (
    "channel_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_read_at" timestamp with time zone
);


ALTER TABLE "public"."channel_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."channels" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "is_private" boolean DEFAULT false NOT NULL,
    "emoji" "text",
    "position" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_dm" boolean DEFAULT false NOT NULL,
    "dm_pair" "text",
    "parent_id" "uuid",
    "section_id" "uuid",
    "is_group" boolean DEFAULT false
);


ALTER TABLE "public"."channels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_sections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT '#D00400'::"text",
    "position" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."chat_sections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_services" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "monthly_cents" integer DEFAULT 0 NOT NULL,
    "started_at" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_services" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_team_members" (
    "client_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_team_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "initial" "text",
    "avatar_bg" "text" DEFAULT '#22344F'::"text" NOT NULL,
    "avatar_fg" "text" DEFAULT '#9DC0F0'::"text" NOT NULL,
    "status" "public"."client_status" DEFAULT 'active'::"public"."client_status" NOT NULL,
    "owner_id" "uuid",
    "mrr_cents" integer DEFAULT 0 NOT NULL,
    "started_at" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stripe_customer_id" "text",
    "email" "text",
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "company_website" "text",
    "industry" "text",
    "address" "text",
    "timezone" "text",
    "logo_url" "text",
    "onboarding_token" "text",
    "onboarding_answers" "jsonb" DEFAULT '{}'::"jsonb",
    "onboarding_submitted_at" timestamp with time zone,
    "onboarding_sent_at" timestamp with time zone,
    "phone" "text",
    "services" "text",
    "onboarding_form_url" "text",
    "custom_fields" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."clients_public" AS
 SELECT "id",
    "name",
    "slug",
    "initial",
    "avatar_bg",
    "avatar_fg",
    "status",
    "owner_id",
    "started_at",
    "notes",
    "created_at",
    "updated_at"
   FROM "public"."clients";


ALTER VIEW "public"."clients_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."day_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."day_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Untitled'::"text" NOT NULL,
    "content_html" "text" DEFAULT ''::"text" NOT NULL,
    "is_default" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."email_signatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "subject" "text",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."email_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emails" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "gmail_id" "text" NOT NULL,
    "thread_id" "text",
    "from_email" "text",
    "from_name" "text",
    "to_emails" "text",
    "subject" "text",
    "snippet" "text",
    "body_html" "text",
    "body_text" "text",
    "is_unread" boolean DEFAULT true NOT NULL,
    "is_starred" boolean DEFAULT false NOT NULL,
    "has_attachments" boolean DEFAULT false NOT NULL,
    "labels" "text"[],
    "received_at" timestamp with time zone NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "from_address" "text"
);


ALTER TABLE "public"."emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_types" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "duration_min" integer DEFAULT 30 NOT NULL,
    "buffer_before_min" integer DEFAULT 0,
    "buffer_after_min" integer DEFAULT 0,
    "color" "text" DEFAULT '#D00400'::"text",
    "location_type" "text" DEFAULT 'video'::"text",
    "location_detail" "text",
    "availability" "jsonb" DEFAULT '{"fri": ["09:00-18:00"], "mon": ["09:00-18:00"], "thu": ["09:00-18:00"], "tue": ["09:00-18:00"], "wed": ["09:00-18:00"]}'::"jsonb",
    "timezone" "text" DEFAULT 'UTC'::"text",
    "min_notice_hours" integer DEFAULT 4,
    "max_advance_days" integer DEFAULT 60,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "auto_generate_meet" boolean DEFAULT true,
    "invitees" "jsonb" DEFAULT '[]'::"jsonb",
    "questions" "jsonb" DEFAULT '[]'::"jsonb",
    "blackout_dates" "jsonb" DEFAULT '[]'::"jsonb"
);


ALTER TABLE "public"."event_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gcal_tokens" (
    "profile_id" "uuid" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" timestamp with time zone,
    "scope" "text",
    "email" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sync_at" timestamp with time zone,
    "slot" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."gcal_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gmail_tokens" (
    "profile_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "scope" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sync_at" timestamp with time zone
);


ALTER TABLE "public"."gmail_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hercules_outputs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "workflow_type" "text" NOT NULL,
    "title" "text",
    "input_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "output_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "output_markdown" "text",
    "status" "text" DEFAULT 'done'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cross_agent_results" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "hercules_outputs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'done'::"text", 'failed'::"text"]))),
    CONSTRAINT "hercules_outputs_workflow_type_check" CHECK (("workflow_type" = ANY (ARRAY['url_audit'::"text", 'geo_audit'::"text", 'keywords'::"text", 'vulcan_social_campaign'::"text", 'vulcan_social_pack'::"text", 'vulcan_og_card'::"text", 'vulcan_diagram'::"text", 'vulcan_brand_pack'::"text"])))
);


ALTER TABLE "public"."hercules_outputs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."hercules_outputs"."cross_agent_results" IS 'Map of fix_id => { agent, status (running|done|failed), result_markdown, result_data, started_at, completed_at }';



CREATE TABLE IF NOT EXISTS "public"."huddles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel_id" "uuid" NOT NULL,
    "started_by" "uuid" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."huddles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoice_items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_amount_cents" integer DEFAULT 0 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invoice_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "number" "text" NOT NULL,
    "status" "public"."invoice_status" DEFAULT 'draft'::"public"."invoice_status" NOT NULL,
    "description" "text",
    "amount_cents" integer DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "due_date" "date",
    "paid_at" timestamp with time zone,
    "stripe_invoice_id" "text",
    "stripe_pi_id" "text",
    "payment_link" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."live_pages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "title" "text" NOT NULL,
    "subtitle" "text",
    "source_text" "text",
    "sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "hero" "jsonb",
    "is_published" boolean DEFAULT false NOT NULL,
    "is_password_protected" boolean DEFAULT false NOT NULL,
    "password_hash" "text",
    "view_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "page_type" "text" DEFAULT 'landing'::"text",
    CONSTRAINT "live_pages_page_type_check" CHECK (("page_type" = ANY (ARRAY['landing'::"text", 'report'::"text", 'website_proposal'::"text", 'marketing_proposal'::"text"])))
);


ALTER TABLE "public"."live_pages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."magnus_missions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "brief" "text" NOT NULL,
    "target_url" "text",
    "brand_kit_id" "uuid",
    "intro_message" "text",
    "plan_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "results_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "final_summary" "text",
    "status" "text" DEFAULT 'planned'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "magnus_missions_status_check" CHECK (("status" = ANY (ARRAY['planned'::"text", 'running'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."magnus_missions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_transcripts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meeting_id" "uuid" NOT NULL,
    "speaker_name" "text",
    "speaker_profile_id" "uuid",
    "content" "text" NOT NULL,
    "ts" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meeting_transcripts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token" "text" NOT NULL,
    "booking_id" "uuid",
    "event_type_id" "uuid",
    "host_profile_id" "uuid",
    "title" "text",
    "guest_name" "text",
    "guest_email" "text",
    "status" "text" DEFAULT 'scheduled'::"text",
    "scheduled_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "duration_seconds" integer DEFAULT 0,
    "recording_enabled" boolean DEFAULT false,
    "transcript_enabled" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meetings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_attachments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "uploader_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_size" bigint,
    "mime_type" "text",
    "storage_path" "text" NOT NULL,
    "width" integer,
    "height" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."message_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "emoji" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."message_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reads" (
    "message_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "read_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."message_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "channel_id" "uuid" NOT NULL,
    "author_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "edited_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pinned_at" timestamp with time zone,
    "pinned_by" "uuid",
    "parent_id" "uuid",
    "reply_count" integer DEFAULT 0 NOT NULL,
    "last_reply_at" timestamp with time zone,
    "voice_note_url" "text",
    "voice_note_duration_ms" integer
);

ALTER TABLE ONLY "public"."messages" REPLICA IDENTITY FULL;


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mrr_snapshots" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "date" "date" NOT NULL,
    "mrr_cents" integer DEFAULT 0 NOT NULL,
    "paid_cents" integer DEFAULT 0 NOT NULL,
    "pending_cents" integer DEFAULT 0 NOT NULL,
    "client_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mrr_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "title" "text" DEFAULT ''::"text",
    "body" "text" DEFAULT ''::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "profile_id" "uuid" NOT NULL,
    "notify_dms" boolean DEFAULT true NOT NULL,
    "notify_mentions" boolean DEFAULT true NOT NULL,
    "notify_all_messages" boolean DEFAULT false NOT NULL,
    "notify_huddle_invites" boolean DEFAULT true NOT NULL,
    "notify_bookings" boolean DEFAULT true NOT NULL,
    "sound_enabled" boolean DEFAULT true NOT NULL,
    "desktop_push_enabled" boolean DEFAULT true NOT NULL,
    "email_digest_enabled" boolean DEFAULT false NOT NULL,
    "quiet_hours_enabled" boolean DEFAULT false NOT NULL,
    "quiet_hours_start" "text" DEFAULT '22:00'::"text",
    "quiet_hours_end" "text" DEFAULT '08:00'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "type" "text" DEFAULT 'task_assigned'::"text" NOT NULL,
    "title" "text",
    "body" "text",
    "task_id" "uuid",
    "project_id" "uuid",
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "display_name" "text",
    "avatar_url" "text",
    "avatar_bg" "text" DEFAULT '#4A2424'::"text" NOT NULL,
    "avatar_fg" "text" DEFAULT '#F0A0A0'::"text" NOT NULL,
    "role" "public"."user_role" DEFAULT 'member'::"public"."user_role" NOT NULL,
    "status" "public"."user_status" DEFAULT 'offline'::"public"."user_status" NOT NULL,
    "status_label" "text",
    "focus_text" "text",
    "current_client_id" "uuid",
    "current_task_label" "text",
    "timezone" "text" DEFAULT 'Europe/Paris'::"text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"(),
    "last_active_at" timestamp with time zone DEFAULT "now"(),
    "onboarded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "bio" "text",
    "booking_slug" "text",
    "notif_settings" "jsonb" DEFAULT '{"push": false, "sound": true}'::"jsonb",
    "client_link_id" "uuid",
    "email_signature_html" "text",
    "booking_prefs" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."booking_prefs" IS 'Per-user global booking preferences. Schema:
   {
     "timezone": "Europe/Paris",
     "default_duration": 30,
     "working_hours": { "start": "09:00", "end": "18:00" },
     "working_days": ["mon","tue","wed","thu","fri"],
     "buffer_minutes": 0,
     "min_notice_hours": 2,
     "max_horizon_days": 60,
     "notification_email": null
   }';



CREATE TABLE IF NOT EXISTS "public"."project_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" DEFAULT 'text'::"text" NOT NULL,
    "options" "jsonb" DEFAULT '[]'::"jsonb",
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_fields" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_by" "uuid"
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_priorities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "color" "text" DEFAULT '#D00400'::"text" NOT NULL,
    "emoji" "text",
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'priority'::"text" NOT NULL,
    CONSTRAINT "project_priorities_kind_check" CHECK (("kind" = ANY (ARRAY['priority'::"text", 'resistance'::"text", 'importance'::"text"])))
);


ALTER TABLE "public"."project_priorities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_views" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "public"."view_type" NOT NULL,
    "position" numeric DEFAULT 0 NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "mode" "text" DEFAULT 'list'::"text",
    "sections" "jsonb" DEFAULT '[]'::"jsonb",
    "view_key" "text",
    "profile_id" "uuid"
);


ALTER TABLE "public"."project_views" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "color" "text" DEFAULT '#D00400'::"text" NOT NULL,
    "description" "text",
    "created_by" "uuid" NOT NULL,
    "position" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text",
    "deadline" "date",
    "client_id" "uuid"
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recordings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "title" "text" DEFAULT ''::"text",
    "storage_path" "text" NOT NULL,
    "url" "text",
    "duration_secs" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "transcript" "text",
    "summary" "text",
    "action_items" "jsonb",
    "folder" "text"
);


ALTER TABLE "public"."recordings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."share_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pack_id" "uuid" NOT NULL,
    "post_index" integer NOT NULL,
    "action" "text" NOT NULL,
    "comment" "text",
    "reviewer_name" "text",
    "reviewer_ip_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "share_feedback_action_check" CHECK (("action" = ANY (ARRAY['approve'::"text", 'reject'::"text", 'comment'::"text"])))
);


ALTER TABLE "public"."share_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."share_packs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "title" "text" NOT NULL,
    "subtitle" "text",
    "client_name" "text",
    "posts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by_email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "view_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."share_packs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_config" (
    "id" integer DEFAULT 1 NOT NULL,
    "publishable_key" "text",
    "mode" "text" DEFAULT 'test'::"text" NOT NULL,
    "currency" "text" DEFAULT 'usd'::"text" NOT NULL,
    "business_name" "text",
    "connected_at" timestamp with time zone,
    CONSTRAINT "singleton" CHECK (("id" = 1))
);


ALTER TABLE "public"."stripe_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_tokens" (
    "profile_id" "uuid" NOT NULL,
    "stripe_user_id" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "publishable_key" "text",
    "livemode" boolean DEFAULT false NOT NULL,
    "scope" "text" DEFAULT 'read_write'::"text",
    "business_name" "text",
    "display_name" "text",
    "email" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sync_at" timestamp with time zone
);


ALTER TABLE "public"."stripe_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subtasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "done" boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subtasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_comments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."task_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_subtasks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "done" boolean DEFAULT false NOT NULL,
    "position" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."task_subtasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "view_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "priority" "public"."task_priority" DEFAULT 'medium'::"public"."task_priority" NOT NULL,
    "resistance_rank" smallint,
    "importance_rank" smallint,
    "category" "text",
    "status" "public"."task_status" DEFAULT 'todo'::"public"."task_status" NOT NULL,
    "client_id" "uuid",
    "assigned_to" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "due_at" timestamp with time zone,
    "position" numeric DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "completed_by" "uuid",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "due_date" "date",
    "priority_label" "text",
    "custom_fields" "jsonb" DEFAULT '{}'::"jsonb",
    "resistance_label" "text",
    "importance_label" "text",
    "department" "text"
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."time_sessions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "task_id" "uuid",
    "task_label" "text",
    "status" "public"."session_status" DEFAULT 'running'::"public"."session_status" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paused_at" timestamp with time zone,
    "total_paused_ms" bigint DEFAULT 0 NOT NULL,
    "ended_at" timestamp with time zone,
    "duration_seconds" integer DEFAULT 0,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_label" "text",
    "project_id" "uuid"
);


ALTER TABLE "public"."time_sessions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."unread_counts" AS
 SELECT "c"."id" AS "channel_id",
    "c"."name",
    "c"."is_dm",
    "cm"."profile_id",
    COALESCE("cm"."last_read_at", "c"."created_at") AS "last_read_at",
    ( SELECT "count"(*) AS "count"
           FROM "public"."messages" "m"
          WHERE (("m"."channel_id" = "c"."id") AND ("m"."author_id" <> "cm"."profile_id") AND ("m"."created_at" > COALESCE("cm"."last_read_at", "c"."created_at")))) AS "unread_count"
   FROM ("public"."channels" "c"
     JOIN "public"."channel_members" "cm" ON (("cm"."channel_id" = "c"."id")));


ALTER VIEW "public"."unread_counts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vulcan_videos" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "operation_name" "text",
    "prompt_motion" "text",
    "source_image_caption" "text",
    "storage_path" "text",
    "public_url" "text",
    "error_message" "text",
    "duration_s" integer DEFAULT 8 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vulcan_videos_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."vulcan_videos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint DEFAULT 0 NOT NULL,
    "storage_path" "text" NOT NULL,
    "folder" "text" DEFAULT ''::"text",
    "tags" "text"[] DEFAULT ARRAY[]::"text"[],
    "is_public" boolean DEFAULT false NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_id" "uuid",
    "folder_id" "uuid"
);


ALTER TABLE "public"."workspace_files" OWNER TO "postgres";


COMMENT ON COLUMN "public"."workspace_files"."client_id" IS 'Optional FK to clients.id — when set, scopes the file to that client. Clients (role=client) can only see/upload files where this matches their client_link_id.';



CREATE OR REPLACE VIEW "public"."workspace_files_stats" AS
 SELECT "count"(*) AS "total_count",
    COALESCE("sum"("size_bytes"), (0)::numeric) AS "total_size_bytes",
    "count"(*) FILTER (WHERE ("mime_type" ~~ 'image/%'::"text")) AS "image_count",
    "count"(*) FILTER (WHERE ("mime_type" ~~ 'video/%'::"text")) AS "video_count",
    "count"(*) FILTER (WHERE ("mime_type" = 'application/pdf'::"text")) AS "pdf_count",
    "count"(*) FILTER (WHERE ("mime_type" ~~ 'audio/%'::"text")) AS "audio_count",
    "count"(DISTINCT "folder") FILTER (WHERE ("folder" <> ''::"text")) AS "folder_count"
   FROM "public"."workspace_files";


ALTER VIEW "public"."workspace_files_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "parent_folder_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "client_id" "uuid",
    "is_client_folder" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."workspace_folders" OWNER TO "postgres";


ALTER TABLE ONLY "public"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_folders"
    ADD CONSTRAINT "ai_folders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_messages"
    ADD CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_cancel_token_key" UNIQUE ("cancel_token");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brand_kits"
    ADD CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_profile_gcal_uniq" UNIQUE ("profile_id", "gcal_event_id");



ALTER TABLE ONLY "public"."channel_canvas"
    ADD CONSTRAINT "channel_canvas_pkey" PRIMARY KEY ("channel_id");



ALTER TABLE ONLY "public"."channel_members"
    ADD CONSTRAINT "channel_members_pkey" PRIMARY KEY ("channel_id", "profile_id");



ALTER TABLE ONLY "public"."channels"
    ADD CONSTRAINT "channels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."channels"
    ADD CONSTRAINT "channels_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."chat_sections"
    ADD CONSTRAINT "chat_sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_services"
    ADD CONSTRAINT "client_services_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_team_members"
    ADD CONSTRAINT "client_team_members_pkey" PRIMARY KEY ("client_id", "profile_id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_onboarding_token_key" UNIQUE ("onboarding_token");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."day_sessions"
    ADD CONSTRAINT "day_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_signatures"
    ADD CONSTRAINT "email_signatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_profile_id_gmail_id_key" UNIQUE ("profile_id", "gmail_id");



ALTER TABLE ONLY "public"."event_types"
    ADD CONSTRAINT "event_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_types"
    ADD CONSTRAINT "event_types_profile_slug_uniq" UNIQUE ("profile_id", "slug");



ALTER TABLE ONLY "public"."gcal_tokens"
    ADD CONSTRAINT "gcal_tokens_pkey" PRIMARY KEY ("profile_id");



ALTER TABLE ONLY "public"."gcal_tokens"
    ADD CONSTRAINT "gcal_tokens_profile_slot_key" UNIQUE ("profile_id", "slot");



ALTER TABLE ONLY "public"."gmail_tokens"
    ADD CONSTRAINT "gmail_tokens_pkey" PRIMARY KEY ("profile_id");



ALTER TABLE ONLY "public"."hercules_outputs"
    ADD CONSTRAINT "hercules_outputs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."huddles"
    ADD CONSTRAINT "huddles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."invoice_items"
    ADD CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."live_pages"
    ADD CONSTRAINT "live_pages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."live_pages"
    ADD CONSTRAINT "live_pages_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."magnus_missions"
    ADD CONSTRAINT "magnus_missions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting_transcripts"
    ADD CONSTRAINT "meeting_transcripts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_profile_id_emoji_key" UNIQUE ("message_id", "profile_id", "emoji");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_pkey" PRIMARY KEY ("message_id", "profile_id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mrr_snapshots"
    ADD CONSTRAINT "mrr_snapshots_date_key" UNIQUE ("date");



ALTER TABLE ONLY "public"."mrr_snapshots"
    ADD CONSTRAINT "mrr_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("profile_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_booking_slug_key" UNIQUE ("booking_slug");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_fields"
    ADD CONSTRAINT "project_fields_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_profile_id_key" UNIQUE ("project_id", "profile_id");



ALTER TABLE ONLY "public"."project_priorities"
    ADD CONSTRAINT "project_priorities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_views"
    ADD CONSTRAINT "project_views_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."recordings"
    ADD CONSTRAINT "recordings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."share_feedback"
    ADD CONSTRAINT "share_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."share_packs"
    ADD CONSTRAINT "share_packs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."share_packs"
    ADD CONSTRAINT "share_packs_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."stripe_config"
    ADD CONSTRAINT "stripe_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_tokens"
    ADD CONSTRAINT "stripe_tokens_pkey" PRIMARY KEY ("profile_id");



ALTER TABLE ONLY "public"."subtasks"
    ADD CONSTRAINT "subtasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_subtasks"
    ADD CONSTRAINT "task_subtasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_sessions"
    ADD CONSTRAINT "time_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vulcan_videos"
    ADD CONSTRAINT "vulcan_videos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_files"
    ADD CONSTRAINT "workspace_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_files"
    ADD CONSTRAINT "workspace_files_storage_path_key" UNIQUE ("storage_path");



ALTER TABLE ONLY "public"."workspace_folders"
    ADD CONSTRAINT "workspace_folders_pkey" PRIMARY KEY ("id");



CREATE INDEX "channels_parent_id_idx" ON "public"."channels" USING "btree" ("parent_id");



CREATE INDEX "channels_section_id_idx" ON "public"."channels" USING "btree" ("section_id");



CREATE INDEX "chat_sections_profile_idx" ON "public"."chat_sections" USING "btree" ("profile_id");



CREATE INDEX "email_signatures_profile_idx" ON "public"."email_signatures" USING "btree" ("profile_id");



CREATE INDEX "email_templates_profile_id_idx" ON "public"."email_templates" USING "btree" ("profile_id");



CREATE UNIQUE INDEX "emails_profile_gmail_unique" ON "public"."emails" USING "btree" ("profile_id", "gmail_id");



CREATE INDEX "emails_profile_received" ON "public"."emails" USING "btree" ("profile_id", "received_at" DESC);



CREATE INDEX "event_types_invitees_gin" ON "public"."event_types" USING "gin" ("invitees");



CREATE INDEX "idx_ai_conversations_client" ON "public"."ai_conversations" USING "btree" ("client_id");



CREATE INDEX "idx_ai_conversations_folder" ON "public"."ai_conversations" USING "btree" ("folder_id");



CREATE INDEX "idx_ai_conversations_profile" ON "public"."ai_conversations" USING "btree" ("profile_id", "updated_at" DESC);



CREATE INDEX "idx_ai_folders_profile" ON "public"."ai_folders" USING "btree" ("profile_id", "position");



CREATE INDEX "idx_ai_messages_conv" ON "public"."ai_messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "idx_bookings_event_type" ON "public"."bookings" USING "btree" ("event_type_id");



CREATE INDEX "idx_bookings_host" ON "public"."bookings" USING "btree" ("host_profile_id", "start_at");



CREATE INDEX "idx_bookings_start" ON "public"."bookings" USING "btree" ("start_at");



CREATE INDEX "idx_brand_kits_client" ON "public"."brand_kits" USING "btree" ("client_id");



CREATE INDEX "idx_cal_events_gcal" ON "public"."calendar_events" USING "btree" ("profile_id", "gcal_event_id") WHERE ("gcal_event_id" IS NOT NULL);



CREATE INDEX "idx_cal_events_profile" ON "public"."calendar_events" USING "btree" ("profile_id");



CREATE INDEX "idx_cal_events_start" ON "public"."calendar_events" USING "btree" ("profile_id", "start_at");



CREATE INDEX "idx_channel_members_profile" ON "public"."channel_members" USING "btree" ("profile_id");



CREATE UNIQUE INDEX "idx_channels_dm_pair" ON "public"."channels" USING "btree" ("dm_pair") WHERE ("dm_pair" IS NOT NULL);



CREATE INDEX "idx_channels_position" ON "public"."channels" USING "btree" ("position");



CREATE INDEX "idx_client_services_client" ON "public"."client_services" USING "btree" ("client_id");



CREATE INDEX "idx_client_team_profile" ON "public"."client_team_members" USING "btree" ("profile_id");



CREATE INDEX "idx_clients_owner" ON "public"."clients" USING "btree" ("owner_id");



CREATE INDEX "idx_clients_status" ON "public"."clients" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_day_sessions_active_per_user" ON "public"."day_sessions" USING "btree" ("profile_id") WHERE ("ended_at" IS NULL);



CREATE INDEX "idx_day_sessions_profile_started" ON "public"."day_sessions" USING "btree" ("profile_id", "started_at" DESC);



CREATE INDEX "idx_day_sessions_started" ON "public"."day_sessions" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_emails_profile_received" ON "public"."emails" USING "btree" ("profile_id", "received_at" DESC);



CREATE INDEX "idx_emails_unread" ON "public"."emails" USING "btree" ("profile_id", "is_unread") WHERE ("is_unread" = true);



CREATE INDEX "idx_event_types_profile" ON "public"."event_types" USING "btree" ("profile_id");



CREATE INDEX "idx_hercules_outputs_profile" ON "public"."hercules_outputs" USING "btree" ("profile_id", "created_at" DESC);



CREATE INDEX "idx_hercules_outputs_type" ON "public"."hercules_outputs" USING "btree" ("workflow_type", "created_at" DESC);



CREATE INDEX "idx_huddles_channel_active" ON "public"."huddles" USING "btree" ("channel_id", "is_active");



CREATE INDEX "idx_invitations_email" ON "public"."invitations" USING "btree" ("lower"("email"));



CREATE INDEX "idx_invitations_pending" ON "public"."invitations" USING "btree" ("email") WHERE (("accepted_at" IS NULL) AND ("revoked_at" IS NULL));



CREATE INDEX "idx_invitations_token" ON "public"."invitations" USING "btree" ("token");



CREATE INDEX "idx_invoice_items_invoice" ON "public"."invoice_items" USING "btree" ("invoice_id", "position");



CREATE INDEX "idx_invoices_client" ON "public"."invoices" USING "btree" ("client_id");



CREATE INDEX "idx_invoices_created" ON "public"."invoices" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_invoices_status" ON "public"."invoices" USING "btree" ("status");



CREATE INDEX "idx_live_pages_profile" ON "public"."live_pages" USING "btree" ("profile_id", "created_at" DESC);



CREATE INDEX "idx_live_pages_slug" ON "public"."live_pages" USING "btree" ("slug");



CREATE INDEX "idx_magnus_missions_status" ON "public"."magnus_missions" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_message_reactions_msg" ON "public"."message_reactions" USING "btree" ("message_id");



CREATE INDEX "idx_message_reads_msg" ON "public"."message_reads" USING "btree" ("message_id");



CREATE INDEX "idx_message_reads_profile" ON "public"."message_reads" USING "btree" ("profile_id");



CREATE INDEX "idx_messages_author" ON "public"."messages" USING "btree" ("author_id");



CREATE INDEX "idx_messages_channel_created" ON "public"."messages" USING "btree" ("channel_id", "created_at" DESC);



CREATE INDEX "idx_messages_parent" ON "public"."messages" USING "btree" ("parent_id") WHERE ("parent_id" IS NOT NULL);



CREATE INDEX "idx_messages_pinned" ON "public"."messages" USING "btree" ("channel_id", "pinned_at") WHERE ("pinned_at" IS NOT NULL);



CREATE INDEX "idx_msg_attachments_msg" ON "public"."message_attachments" USING "btree" ("message_id");



CREATE INDEX "idx_profiles_client_link" ON "public"."profiles" USING "btree" ("client_link_id") WHERE ("client_link_id" IS NOT NULL);



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_profiles_status" ON "public"."profiles" USING "btree" ("status");



CREATE INDEX "idx_project_fields_project" ON "public"."project_fields" USING "btree" ("project_id", "position");



CREATE UNIQUE INDEX "idx_project_fields_unique_name" ON "public"."project_fields" USING "btree" ("project_id", "name");



CREATE INDEX "idx_project_members_profile" ON "public"."project_members" USING "btree" ("profile_id");



CREATE INDEX "idx_project_members_project" ON "public"."project_members" USING "btree" ("project_id");



CREATE INDEX "idx_project_priorities_proj" ON "public"."project_priorities" USING "btree" ("project_id", "position");



CREATE INDEX "idx_project_priorities_project_kind" ON "public"."project_priorities" USING "btree" ("project_id", "kind", "position");



CREATE INDEX "idx_project_views_project" ON "public"."project_views" USING "btree" ("project_id");



CREATE INDEX "idx_projects_position" ON "public"."projects" USING "btree" ("created_by", "position");



CREATE INDEX "idx_task_comments_task" ON "public"."task_comments" USING "btree" ("task_id");



CREATE INDEX "idx_task_subtasks_task" ON "public"."task_subtasks" USING "btree" ("task_id");



CREATE INDEX "idx_tasks_assigned" ON "public"."tasks" USING "gin" ("assigned_to");



CREATE INDEX "idx_tasks_client" ON "public"."tasks" USING "btree" ("client_id");



CREATE INDEX "idx_tasks_name_trgm" ON "public"."tasks" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "idx_tasks_priority_label" ON "public"."tasks" USING "btree" ("priority_label") WHERE ("priority_label" IS NOT NULL);



CREATE INDEX "idx_tasks_project" ON "public"."tasks" USING "btree" ("project_id");



CREATE INDEX "idx_tasks_status" ON "public"."tasks" USING "btree" ("status");



CREATE INDEX "idx_tasks_view" ON "public"."tasks" USING "btree" ("view_id");



CREATE UNIQUE INDEX "idx_time_sessions_active_per_user" ON "public"."time_sessions" USING "btree" ("profile_id") WHERE ("status" = ANY (ARRAY['running'::"public"."session_status", 'paused'::"public"."session_status"]));



CREATE INDEX "idx_time_sessions_client" ON "public"."time_sessions" USING "btree" ("client_id");



CREATE INDEX "idx_time_sessions_profile" ON "public"."time_sessions" USING "btree" ("profile_id");



CREATE INDEX "idx_time_sessions_profile_started" ON "public"."time_sessions" USING "btree" ("profile_id", "started_at" DESC);



CREATE INDEX "idx_time_sessions_started" ON "public"."time_sessions" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_time_sessions_started_at" ON "public"."time_sessions" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_time_sessions_status" ON "public"."time_sessions" USING "btree" ("status");



CREATE INDEX "idx_vulcan_videos_status" ON "public"."vulcan_videos" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "live_pages_page_type_idx" ON "public"."live_pages" USING "btree" ("page_type");



CREATE INDEX "meetings_booking" ON "public"."meetings" USING "btree" ("booking_id");



CREATE INDEX "meetings_host" ON "public"."meetings" USING "btree" ("host_profile_id");



CREATE INDEX "meetings_status" ON "public"."meetings" USING "btree" ("status");



CREATE INDEX "meetings_token" ON "public"."meetings" USING "btree" ("token");



CREATE INDEX "notes_profile_id_idx" ON "public"."notes" USING "btree" ("profile_id");



CREATE INDEX "notifications_recipient_idx" ON "public"."notifications" USING "btree" ("recipient_id", "created_at" DESC);



CREATE INDEX "project_views_key_idx" ON "public"."project_views" USING "btree" ("project_id", "view_key");



CREATE INDEX "project_views_project_idx" ON "public"."project_views" USING "btree" ("project_id");



CREATE INDEX "recordings_created_idx" ON "public"."recordings" USING "btree" ("created_at" DESC);



CREATE INDEX "recordings_folder_idx" ON "public"."recordings" USING "btree" ("folder");



CREATE INDEX "share_feedback_created_at_idx" ON "public"."share_feedback" USING "btree" ("created_at" DESC);



CREATE INDEX "share_feedback_pack_id_idx" ON "public"."share_feedback" USING "btree" ("pack_id");



CREATE INDEX "share_packs_created_at_idx" ON "public"."share_packs" USING "btree" ("created_at" DESC);



CREATE INDEX "share_packs_created_by_idx" ON "public"."share_packs" USING "btree" ("created_by_email");



CREATE INDEX "share_packs_slug_idx" ON "public"."share_packs" USING "btree" ("slug");



CREATE INDEX "subtasks_task_id_idx" ON "public"."subtasks" USING "btree" ("task_id");



CREATE INDEX "task_comments_created_idx" ON "public"."task_comments" USING "btree" ("created_at");



CREATE INDEX "task_comments_task_idx" ON "public"."task_comments" USING "btree" ("task_id");



CREATE INDEX "transcripts_meeting" ON "public"."meeting_transcripts" USING "btree" ("meeting_id", "ts");



CREATE UNIQUE INDEX "uniq_huddle_active_per_channel" ON "public"."huddles" USING "btree" ("channel_id") WHERE ("is_active" = true);



CREATE UNIQUE INDEX "uniq_time_sessions_one_running_per_user" ON "public"."time_sessions" USING "btree" ("profile_id") WHERE ("status" = 'running'::"public"."session_status");



CREATE INDEX "workspace_files_client_id_idx" ON "public"."workspace_files" USING "btree" ("client_id");



CREATE INDEX "workspace_files_created_at_idx" ON "public"."workspace_files" USING "btree" ("created_at" DESC);



CREATE INDEX "workspace_files_folder_id_idx" ON "public"."workspace_files" USING "btree" ("folder_id");



CREATE INDEX "workspace_files_folder_idx" ON "public"."workspace_files" USING "btree" ("folder");



CREATE INDEX "workspace_files_name_trgm_idx" ON "public"."workspace_files" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE INDEX "workspace_files_uploaded_by_idx" ON "public"."workspace_files" USING "btree" ("uploaded_by");



CREATE INDEX "workspace_folders_client_idx" ON "public"."workspace_folders" USING "btree" ("client_id");



CREATE INDEX "workspace_folders_created_by_idx" ON "public"."workspace_folders" USING "btree" ("created_by");



CREATE INDEX "workspace_folders_parent_idx" ON "public"."workspace_folders" USING "btree" ("parent_folder_id");



CREATE OR REPLACE TRIGGER "trg_ai_conversations_updated_at" BEFORE UPDATE ON "public"."ai_conversations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_bookings_updated_at" BEFORE UPDATE ON "public"."bookings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_brand_kits_updated_at" BEFORE UPDATE ON "public"."brand_kits" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cal_events_updated_at" BEFORE UPDATE ON "public"."calendar_events" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_channels_updated_at" BEFORE UPDATE ON "public"."channels" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_clients_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_event_types_updated_at" BEFORE UPDATE ON "public"."event_types" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_invoice_number" BEFORE INSERT ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."generate_invoice_number"();



CREATE OR REPLACE TRIGGER "trg_invoices_updated_at" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_live_pages_updated" BEFORE UPDATE ON "public"."live_pages" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_live_pages"();



CREATE OR REPLACE TRIGGER "trg_magnus_missions_updated_at" BEFORE UPDATE ON "public"."magnus_missions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_new_profile_join_channels" AFTER INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_profile_join_channels"();



CREATE OR REPLACE TRIGGER "trg_new_public_channel" AFTER INSERT ON "public"."channels" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_public_channel"();



CREATE OR REPLACE TRIGGER "trg_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_send_invitation_email" AFTER INSERT ON "public"."invitations" FOR EACH ROW EXECUTE FUNCTION "public"."send_invitation_email"();



CREATE OR REPLACE TRIGGER "trg_tasks_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_thread_reply" AFTER INSERT OR DELETE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."handle_thread_reply"();



CREATE OR REPLACE TRIGGER "trg_time_sessions_updated_at" BEFORE UPDATE ON "public"."time_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_update_notification_prefs" BEFORE UPDATE ON "public"."notification_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."update_notification_prefs_timestamp"();



CREATE OR REPLACE TRIGGER "trg_vulcan_videos_updated_at" BEFORE UPDATE ON "public"."vulcan_videos" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "workspace_files_updated_at_trg" BEFORE UPDATE ON "public"."workspace_files" FOR EACH ROW EXECUTE FUNCTION "public"."handle_workspace_files_updated_at"();



ALTER TABLE ONLY "public"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."ai_folders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_conversations"
    ADD CONSTRAINT "ai_conversations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_folders"
    ADD CONSTRAINT "ai_folders_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_messages"
    ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_cal_event_id_fkey" FOREIGN KEY ("cal_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_host_profile_id_fkey" FOREIGN KEY ("host_profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."brand_kits"
    ADD CONSTRAINT "brand_kits_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channel_canvas"
    ADD CONSTRAINT "channel_canvas_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channel_canvas"
    ADD CONSTRAINT "channel_canvas_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."channel_members"
    ADD CONSTRAINT "channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channel_members"
    ADD CONSTRAINT "channel_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channels"
    ADD CONSTRAINT "channels_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."channels"
    ADD CONSTRAINT "channels_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."channels"
    ADD CONSTRAINT "channels_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."chat_sections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_sections"
    ADD CONSTRAINT "chat_sections_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_services"
    ADD CONSTRAINT "client_services_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_team_members"
    ADD CONSTRAINT "client_team_members_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_team_members"
    ADD CONSTRAINT "client_team_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."day_sessions"
    ADD CONSTRAINT "day_sessions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_signatures"
    ADD CONSTRAINT "email_signatures_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_types"
    ADD CONSTRAINT "event_types_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "fk_profiles_current_client" FOREIGN KEY ("current_client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."gcal_tokens"
    ADD CONSTRAINT "gcal_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gmail_tokens"
    ADD CONSTRAINT "gmail_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hercules_outputs"
    ADD CONSTRAINT "hercules_outputs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."huddles"
    ADD CONSTRAINT "huddles_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."huddles"
    ADD CONSTRAINT "huddles_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoice_items"
    ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."live_pages"
    ADD CONSTRAINT "live_pages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."magnus_missions"
    ADD CONSTRAINT "magnus_missions_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "public"."brand_kits"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meeting_transcripts"
    ADD CONSTRAINT "meeting_transcripts_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_transcripts"
    ADD CONSTRAINT "meeting_transcripts_speaker_profile_id_fkey" FOREIGN KEY ("speaker_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_host_profile_id_fkey" FOREIGN KEY ("host_profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pinned_by_fkey" FOREIGN KEY ("pinned_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_client_link_id_fkey" FOREIGN KEY ("client_link_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_fields"
    ADD CONSTRAINT "project_fields_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_priorities"
    ADD CONSTRAINT "project_priorities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_views"
    ADD CONSTRAINT "project_views_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."project_views"
    ADD CONSTRAINT "project_views_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_views"
    ADD CONSTRAINT "project_views_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."recordings"
    ADD CONSTRAINT "recordings_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."share_feedback"
    ADD CONSTRAINT "share_feedback_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "public"."share_packs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stripe_tokens"
    ADD CONSTRAINT "stripe_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subtasks"
    ADD CONSTRAINT "subtasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."subtasks"
    ADD CONSTRAINT "subtasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_comments"
    ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_subtasks"
    ADD CONSTRAINT "task_subtasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_view_id_fkey" FOREIGN KEY ("view_id") REFERENCES "public"."project_views"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_sessions"
    ADD CONSTRAINT "time_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_sessions"
    ADD CONSTRAINT "time_sessions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_sessions"
    ADD CONSTRAINT "time_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_sessions"
    ADD CONSTRAINT "time_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workspace_files"
    ADD CONSTRAINT "workspace_files_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_files"
    ADD CONSTRAINT "workspace_files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."workspace_folders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workspace_files"
    ADD CONSTRAINT "workspace_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workspace_folders"
    ADD CONSTRAINT "workspace_folders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workspace_folders"
    ADD CONSTRAINT "workspace_folders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_folders"
    ADD CONSTRAINT "workspace_folders_parent_folder_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."workspace_folders"("id") ON DELETE CASCADE;



CREATE POLICY "Authenticated can delete share packs" ON "public"."share_packs" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "Authenticated can insert share packs" ON "public"."share_packs" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Authenticated can update share packs" ON "public"."share_packs" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated can view feedback" ON "public"."share_feedback" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Public can view share packs" ON "public"."share_packs" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Users manage their own notification prefs" ON "public"."notification_preferences" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."ai_conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_conversations_self" ON "public"."ai_conversations" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."ai_folders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_folders_self" ON "public"."ai_folders" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."ai_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_messages_self" ON "public"."ai_messages" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."ai_conversations" "c"
  WHERE (("c"."id" = "ai_messages"."conversation_id") AND ("c"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."ai_conversations" "c"
  WHERE (("c"."id" = "ai_messages"."conversation_id") AND ("c"."profile_id" = "auth"."uid"())))));



CREATE POLICY "attachments_delete_self" ON "public"."message_attachments" FOR DELETE TO "authenticated" USING (("uploader_id" = "auth"."uid"()));



CREATE POLICY "attachments_insert_self" ON "public"."message_attachments" FOR INSERT TO "authenticated" WITH CHECK (("uploader_id" = "auth"."uid"()));



CREATE POLICY "attachments_select" ON "public"."message_attachments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."channels" "c" ON (("c"."id" = "m"."channel_id")))
  WHERE (("m"."id" = "message_attachments"."message_id") AND (("c"."is_private" = false) OR (EXISTS ( SELECT 1
           FROM "public"."channel_members" "cm"
          WHERE (("cm"."channel_id" = "c"."id") AND ("cm"."profile_id" = "auth"."uid"())))))))));



ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bookings_anon_cancel" ON "public"."bookings" FOR SELECT TO "anon" USING (("cancel_token" IS NOT NULL));



CREATE POLICY "bookings_anon_insert" ON "public"."bookings" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "bookings_self" ON "public"."bookings" TO "authenticated" USING (("host_profile_id" = "auth"."uid"())) WITH CHECK (("host_profile_id" = "auth"."uid"()));



CREATE POLICY "bookings_view_any" ON "public"."bookings" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."brand_kits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brand_kits_delete" ON "public"."brand_kits" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "brand_kits_delete_authenticated" ON "public"."brand_kits" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "brand_kits_insert" ON "public"."brand_kits" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "brand_kits_select" ON "public"."brand_kits" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "brand_kits_update" ON "public"."brand_kits" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "cal_events_self" ON "public"."calendar_events" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "cal_events_view_busy" ON "public"."calendar_events" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "canvas_insert_member" ON "public"."channel_canvas" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."channel_members" "cm"
  WHERE (("cm"."channel_id" = "channel_canvas"."channel_id") AND ("cm"."profile_id" = "auth"."uid"())))));



CREATE POLICY "canvas_select_member" ON "public"."channel_canvas" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."channel_members" "cm"
  WHERE (("cm"."channel_id" = "channel_canvas"."channel_id") AND ("cm"."profile_id" = "auth"."uid"())))));



CREATE POLICY "canvas_update_member" ON "public"."channel_canvas" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."channel_members" "cm"
  WHERE (("cm"."channel_id" = "channel_canvas"."channel_id") AND ("cm"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."channel_canvas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."channel_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "channel_members_admin_delete" ON "public"."channel_members" FOR DELETE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'admin'::"text"])))))));



CREATE POLICY "channel_members_admin_insert" ON "public"."channel_members" FOR INSERT TO "authenticated" WITH CHECK ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'admin'::"text"])))))));



CREATE POLICY "channel_members_delete_self_or_mgr" ON "public"."channel_members" FOR DELETE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR "public"."is_manager_or_owner"()));



CREATE POLICY "channel_members_insert_self_or_mgr" ON "public"."channel_members" FOR INSERT TO "authenticated" WITH CHECK ((("profile_id" = "auth"."uid"()) OR "public"."is_manager_or_owner"()));



CREATE POLICY "channel_members_select" ON "public"."channel_members" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "channel_members_update_self" ON "public"."channel_members" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."channels" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "channels_delete_owner" ON "public"."channels" FOR DELETE TO "authenticated" USING ("public"."is_owner"());



CREATE POLICY "channels_delete_owner_mgr" ON "public"."channels" FOR DELETE TO "authenticated" USING ((("created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'admin'::"text"])))))));



CREATE POLICY "channels_insert_mgr" ON "public"."channels" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_manager_or_owner"());



CREATE POLICY "channels_select" ON "public"."channels" FOR SELECT TO "authenticated" USING ((("is_private" = false) OR (EXISTS ( SELECT 1
   FROM "public"."channel_members" "cm"
  WHERE (("cm"."channel_id" = "channels"."id") AND ("cm"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "channels_update_open" ON "public"."channels" FOR UPDATE USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."chat_sections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_sections_delete" ON "public"."chat_sections" FOR DELETE USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "chat_sections_delete_own" ON "public"."chat_sections" FOR DELETE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'admin'::"text"])))))));



CREATE POLICY "chat_sections_insert" ON "public"."chat_sections" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "chat_sections_insert_own" ON "public"."chat_sections" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "chat_sections_select" ON "public"."chat_sections" FOR SELECT USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "chat_sections_select_all" ON "public"."chat_sections" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "chat_sections_update" ON "public"."chat_sections" FOR UPDATE USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "chat_sections_update_own" ON "public"."chat_sections" FOR UPDATE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'admin'::"text"]))))))) WITH CHECK (true);



ALTER TABLE "public"."client_services" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "client_services_owner" ON "public"."client_services" TO "authenticated" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



ALTER TABLE "public"."client_team_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_delete_owner" ON "public"."clients" FOR DELETE TO "authenticated" USING ("public"."is_owner"());



CREATE POLICY "clients_insert_mgr" ON "public"."clients" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_manager_or_owner"());



CREATE POLICY "clients_public_form_select" ON "public"."clients" FOR SELECT TO "anon" USING (("onboarding_token" IS NOT NULL));



CREATE POLICY "clients_public_form_submit" ON "public"."clients" FOR UPDATE TO "anon" USING (("onboarding_token" IS NOT NULL)) WITH CHECK (("onboarding_token" IS NOT NULL));



CREATE POLICY "clients_select_all" ON "public"."clients" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "clients_update_mgr" ON "public"."clients" FOR UPDATE TO "authenticated" USING ("public"."is_manager_or_owner"());



CREATE POLICY "ctm_delete_mgr" ON "public"."client_team_members" FOR DELETE TO "authenticated" USING ("public"."is_manager_or_owner"());



CREATE POLICY "ctm_insert_mgr" ON "public"."client_team_members" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_manager_or_owner"());



CREATE POLICY "ctm_select_all" ON "public"."client_team_members" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."day_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "day_sessions_self_delete" ON "public"."day_sessions" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "day_sessions_self_read" ON "public"."day_sessions" FOR SELECT TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text"])))))));



CREATE POLICY "day_sessions_self_update" ON "public"."day_sessions" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "day_sessions_self_write" ON "public"."day_sessions" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."email_signatures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_signatures_delete" ON "public"."email_signatures" FOR DELETE USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "email_signatures_insert" ON "public"."email_signatures" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "email_signatures_select" ON "public"."email_signatures" FOR SELECT USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "email_signatures_update" ON "public"."email_signatures" FOR UPDATE USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."email_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_templates_own" ON "public"."email_templates" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."emails" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emails_delete_own" ON "public"."emails" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "emails_insert_own" ON "public"."emails" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "emails_select_own" ON "public"."emails" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "emails_update_own" ON "public"."emails" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."event_types" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_types_delete_own" ON "public"."event_types" FOR DELETE USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "event_types_insert_own" ON "public"."event_types" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "event_types_select_all" ON "public"."event_types" FOR SELECT USING (true);



CREATE POLICY "event_types_select_own" ON "public"."event_types" FOR SELECT USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "event_types_update_own" ON "public"."event_types" FOR UPDATE USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."gcal_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gcal_tokens_self" ON "public"."gcal_tokens" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "gcal_tokens_view_any" ON "public"."gcal_tokens" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "giant_owner_manager_can_invite" ON "public"."invitations" FOR INSERT TO "authenticated" WITH CHECK ((("invited_by" = "auth"."uid"()) AND "public"."giant_can_invite"()));



ALTER TABLE "public"."gmail_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gmail_tokens_self" ON "public"."gmail_tokens" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."hercules_outputs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hercules_self_delete" ON "public"."hercules_outputs" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "hercules_self_read" ON "public"."hercules_outputs" FOR SELECT TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text"])))))));



CREATE POLICY "hercules_self_update" ON "public"."hercules_outputs" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "hercules_self_write" ON "public"."hercules_outputs" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."huddles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "huddles_insert" ON "public"."huddles" FOR INSERT TO "authenticated" WITH CHECK (("started_by" = "auth"."uid"()));



CREATE POLICY "huddles_select" ON "public"."huddles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "huddles_update" ON "public"."huddles" FOR UPDATE TO "authenticated" USING (true);



ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invitations_mgr_insert" ON "public"."invitations" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_manager_or_owner"() AND ("role" = 'member'::"public"."user_role")));



CREATE POLICY "invitations_owner_all" ON "public"."invitations" TO "authenticated" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "invitations_select_auth" ON "public"."invitations" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."invoice_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoice_items_modify" ON "public"."invoice_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"]))))));



CREATE POLICY "invoice_items_select" ON "public"."invoice_items" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_delete" ON "public"."invoices" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"]))))));



CREATE POLICY "invoices_insert" ON "public"."invoices" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"]))))));



CREATE POLICY "invoices_select" ON "public"."invoices" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "invoices_update" ON "public"."invoices" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"]))))));



ALTER TABLE "public"."live_pages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "live_pages_owner" ON "public"."live_pages" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "live_pages_public_read" ON "public"."live_pages" FOR SELECT TO "authenticated", "anon" USING (("is_published" = true));



ALTER TABLE "public"."magnus_missions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "magnus_missions_delete" ON "public"."magnus_missions" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "magnus_missions_insert" ON "public"."magnus_missions" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "magnus_missions_select" ON "public"."magnus_missions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "magnus_missions_update" ON "public"."magnus_missions" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."meeting_transcripts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meetings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetings_delete_host" ON "public"."meetings" FOR DELETE TO "authenticated" USING (("host_profile_id" = "auth"."uid"()));



CREATE POLICY "meetings_insert_host" ON "public"."meetings" FOR INSERT TO "authenticated" WITH CHECK (("host_profile_id" = "auth"."uid"()));



CREATE POLICY "meetings_select_by_token" ON "public"."meetings" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "meetings_update_anon_join" ON "public"."meetings" FOR UPDATE TO "anon" USING (("status" = ANY (ARRAY['scheduled'::"text", 'active'::"text"]))) WITH CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'active'::"text", 'ended'::"text"])));



CREATE POLICY "meetings_update_host" ON "public"."meetings" FOR UPDATE TO "authenticated" USING (("host_profile_id" = "auth"."uid"())) WITH CHECK (("host_profile_id" = "auth"."uid"()));



ALTER TABLE "public"."message_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_reactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_reads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_reads_insert" ON "public"."message_reads" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "message_reads_select" ON "public"."message_reads" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_delete_own" ON "public"."messages" FOR DELETE TO "authenticated" USING (("author_id" = "auth"."uid"()));



CREATE POLICY "messages_delete_self_or_mgr" ON "public"."messages" FOR DELETE TO "authenticated" USING ((("author_id" = "auth"."uid"()) OR "public"."is_manager_or_owner"()));



CREATE POLICY "messages_insert_self" ON "public"."messages" FOR INSERT TO "authenticated" WITH CHECK ((("author_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."channels" "c"
  WHERE (("c"."id" = "messages"."channel_id") AND (("c"."is_private" = false) OR (EXISTS ( SELECT 1
           FROM "public"."channel_members" "cm"
          WHERE (("cm"."channel_id" = "c"."id") AND ("cm"."profile_id" = "auth"."uid"()))))))))));



CREATE POLICY "messages_pin_by_member" ON "public"."messages" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."channel_members" "cm"
  WHERE (("cm"."channel_id" = "messages"."channel_id") AND ("cm"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."channel_members" "cm"
  WHERE (("cm"."channel_id" = "messages"."channel_id") AND ("cm"."profile_id" = "auth"."uid"())))));



CREATE POLICY "messages_pin_by_staff" ON "public"."messages" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"]))))));



CREATE POLICY "messages_select" ON "public"."messages" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."channels" "c"
  WHERE (("c"."id" = "messages"."channel_id") AND (("c"."is_private" = false) OR (EXISTS ( SELECT 1
           FROM "public"."channel_members" "cm"
          WHERE (("cm"."channel_id" = "c"."id") AND ("cm"."profile_id" = "auth"."uid"())))))))));



CREATE POLICY "messages_update_self" ON "public"."messages" FOR UPDATE TO "authenticated" USING (("author_id" = "auth"."uid"())) WITH CHECK (("author_id" = "auth"."uid"()));



ALTER TABLE "public"."mrr_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mrr_snapshots_read" ON "public"."mrr_snapshots" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notes_own_all" ON "public"."notes" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "notif_insert" ON "public"."notifications" FOR INSERT TO "authenticated" WITH CHECK ((("actor_id" = "auth"."uid"()) OR ("actor_id" IS NULL)));



CREATE POLICY "notif_prefs_insert_own" ON "public"."notification_preferences" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "notif_prefs_select_own" ON "public"."notification_preferences" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "notif_prefs_update_own" ON "public"."notification_preferences" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "notif_select_own" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("recipient_id" = "auth"."uid"()));



CREATE POLICY "notif_update_own" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("recipient_id" = "auth"."uid"()));



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pm_delete" ON "public"."project_members" FOR DELETE TO "authenticated" USING ("public"."can_manage_project"("project_id"));



CREATE POLICY "pm_insert" ON "public"."project_members" FOR INSERT TO "authenticated" WITH CHECK ("public"."can_manage_project"("project_id"));



CREATE POLICY "pm_select" ON "public"."project_members" FOR SELECT TO "authenticated" USING ("public"."is_project_member"("project_id"));



CREATE POLICY "pp_modify" ON "public"."project_priorities" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "pp_select" ON "public"."project_priorities" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_delete_owner" ON "public"."profiles" FOR DELETE TO "authenticated" USING ("public"."is_owner"());



CREATE POLICY "profiles_select_all" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "profiles_update_owner" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ("public"."is_owner"()) WITH CHECK ("public"."is_owner"());



CREATE POLICY "profiles_update_self" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."project_fields" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_fields_visible" ON "public"."project_fields" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "project_fields"."project_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "project_fields"."project_id"))));



ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_members_owner_delete" ON "public"."project_members" FOR DELETE TO "authenticated" USING ("public"."is_project_owner"("project_id"));



CREATE POLICY "project_members_owner_insert" ON "public"."project_members" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_project_owner"("project_id"));



CREATE POLICY "project_members_owner_update" ON "public"."project_members" FOR UPDATE TO "authenticated" USING ("public"."is_project_owner"("project_id")) WITH CHECK ("public"."is_project_owner"("project_id"));



CREATE POLICY "project_members_select" ON "public"."project_members" FOR SELECT TO "authenticated" USING (("public"."is_project_owner"("project_id") OR ("profile_id" = "auth"."uid"())));



ALTER TABLE "public"."project_priorities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_priorities_by_visible_project" ON "public"."project_priorities" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "project_priorities"."project_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "project_priorities"."project_id"))));



ALTER TABLE "public"."project_views" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_views_all" ON "public"."project_views" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_all" ON "public"."projects" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "projects_client_scope" ON "public"."projects" FOR SELECT TO "authenticated" USING (((NOT "public"."is_client_user"()) OR ("client_id" = "public"."current_user_client_link"())));



CREATE POLICY "projects_owner_delete" ON "public"."projects" FOR DELETE TO "authenticated" USING (("created_by" = "auth"."uid"()));



CREATE POLICY "projects_owner_insert" ON "public"."projects" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "projects_owner_or_member_select" ON "public"."projects" FOR SELECT TO "authenticated" USING ((("created_by" = "auth"."uid"()) OR "public"."is_project_member"("id")));



CREATE POLICY "projects_owner_or_member_update" ON "public"."projects" FOR UPDATE TO "authenticated" USING ((("created_by" = "auth"."uid"()) OR "public"."is_project_member"("id"))) WITH CHECK ((("created_by" = "auth"."uid"()) OR "public"."is_project_member"("id")));



CREATE POLICY "projects_select_members" ON "public"."projects" FOR SELECT TO "authenticated" USING ("public"."is_project_member"("id"));



CREATE POLICY "reactions_delete_self" ON "public"."message_reactions" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "reactions_insert_self" ON "public"."message_reactions" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "reactions_select" ON "public"."message_reactions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."channels" "c" ON (("c"."id" = "m"."channel_id")))
  WHERE (("m"."id" = "message_reactions"."message_id") AND (("c"."is_private" = false) OR (EXISTS ( SELECT 1
           FROM "public"."channel_members" "cm"
          WHERE (("cm"."channel_id" = "c"."id") AND ("cm"."profile_id" = "auth"."uid"())))))))));



ALTER TABLE "public"."recordings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "recordings_delete_own" ON "public"."recordings" FOR DELETE USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "recordings_insert_own" ON "public"."recordings" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "recordings_meta_delete" ON "public"."recordings" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "recordings_meta_insert" ON "public"."recordings" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "recordings_meta_select" ON "public"."recordings" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "recordings_meta_update" ON "public"."recordings" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "recordings_select_own" ON "public"."recordings" FOR SELECT USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "recordings_update_own" ON "public"."recordings" FOR UPDATE USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."share_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."share_packs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stripe_config_modify" ON "public"."stripe_config" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"public"."user_role"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'owner'::"public"."user_role")))));



CREATE POLICY "stripe_config_read" ON "public"."stripe_config" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."stripe_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stripe_tokens_self" ON "public"."stripe_tokens" TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "stripe_tokens_view_any" ON "public"."stripe_tokens" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."subtasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subtasks_delete" ON "public"."subtasks" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE ("t"."id" = "subtasks"."task_id"))));



CREATE POLICY "subtasks_insert" ON "public"."subtasks" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE ("t"."id" = "subtasks"."task_id"))));



CREATE POLICY "subtasks_select" ON "public"."subtasks" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE ("t"."id" = "subtasks"."task_id"))));



CREATE POLICY "subtasks_update" ON "public"."subtasks" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE ("t"."id" = "subtasks"."task_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."tasks" "t"
  WHERE ("t"."id" = "subtasks"."task_id"))));



ALTER TABLE "public"."task_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_comments_delete_own" ON "public"."task_comments" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "author_id"));



CREATE POLICY "task_comments_insert_own" ON "public"."task_comments" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "author_id"));



CREATE POLICY "task_comments_select_all_authenticated" ON "public"."task_comments" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "task_comments_update_own" ON "public"."task_comments" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "author_id")) WITH CHECK (("auth"."uid"() = "author_id"));



ALTER TABLE "public"."task_subtasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_subtasks_all" ON "public"."task_subtasks" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_client_scope" ON "public"."tasks" FOR SELECT TO "authenticated" USING (((NOT "public"."is_client_user"()) OR (EXISTS ( SELECT 1
   FROM "public"."projects"
  WHERE (("projects"."id" = "tasks"."project_id") AND ("projects"."client_id" = "public"."current_user_client_link"()))))));



CREATE POLICY "tasks_delete_by_visible_project" ON "public"."tasks" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "tasks"."project_id"))));



CREATE POLICY "tasks_delete_mgr" ON "public"."tasks" FOR DELETE TO "authenticated" USING ("public"."is_manager_or_owner"());



CREATE POLICY "tasks_insert_by_visible_project" ON "public"."tasks" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "tasks"."project_id"))));



CREATE POLICY "tasks_insert_members" ON "public"."tasks" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_project_member"("project_id"));



CREATE POLICY "tasks_insert_workspace" ON "public"."tasks" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "tasks_select_assignee" ON "public"."tasks" FOR SELECT TO "authenticated" USING (("assigned_to" @> ARRAY["auth"."uid"()]));



CREATE POLICY "tasks_select_by_visible_project" ON "public"."tasks" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "tasks"."project_id"))));



CREATE POLICY "tasks_select_members" ON "public"."tasks" FOR SELECT TO "authenticated" USING ("public"."is_project_member"("project_id"));



CREATE POLICY "tasks_select_team" ON "public"."tasks" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" IS DISTINCT FROM 'client'::"public"."user_role")))));



CREATE POLICY "tasks_update_assignee" ON "public"."tasks" FOR UPDATE TO "authenticated" USING (("assigned_to" @> ARRAY["auth"."uid"()]));



CREATE POLICY "tasks_update_by_visible_project" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "tasks"."project_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE ("p"."id" = "tasks"."project_id"))));



CREATE POLICY "tasks_update_creator" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "tasks"."project_id") AND ("p"."created_by" = "auth"."uid"())))));



CREATE POLICY "tasks_update_members" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ("public"."is_project_member"("project_id"));



CREATE POLICY "tasks_update_team" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" IS DISTINCT FROM 'client'::"public"."user_role")))));



ALTER TABLE "public"."time_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "time_sessions_delete_self_or_owner" ON "public"."time_sessions" FOR DELETE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR "public"."is_owner"()));



CREATE POLICY "time_sessions_insert_self" ON "public"."time_sessions" FOR INSERT WITH CHECK (("auth"."uid"() = "profile_id"));



CREATE POLICY "time_sessions_select_all" ON "public"."time_sessions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "time_sessions_select_self" ON "public"."time_sessions" FOR SELECT USING (("auth"."uid"() = "profile_id"));



CREATE POLICY "time_sessions_select_team" ON "public"."time_sessions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text"]))))));



CREATE POLICY "time_sessions_update_self" ON "public"."time_sessions" FOR UPDATE USING (("auth"."uid"() = "profile_id"));



CREATE POLICY "transcripts_insert_all" ON "public"."meeting_transcripts" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "transcripts_select_all" ON "public"."meeting_transcripts" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "ts_delete_own" ON "public"."time_sessions" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "ts_insert_own" ON "public"."time_sessions" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "ts_select" ON "public"."time_sessions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "ts_update_own" ON "public"."time_sessions" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."vulcan_videos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vulcan_videos_insert" ON "public"."vulcan_videos" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "vulcan_videos_select" ON "public"."vulcan_videos" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "vulcan_videos_update" ON "public"."vulcan_videos" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."workspace_files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace_files_delete" ON "public"."workspace_files" FOR DELETE TO "authenticated" USING ((("uploaded_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text"])))))));



CREATE POLICY "workspace_files_insert" ON "public"."workspace_files" FOR INSERT TO "authenticated" WITH CHECK (("uploaded_by" = "auth"."uid"()));



CREATE POLICY "workspace_files_read" ON "public"."workspace_files" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'member'::"text"]))))) OR ("uploaded_by" = "auth"."uid"())));



CREATE POLICY "workspace_files_update" ON "public"."workspace_files" FOR UPDATE TO "authenticated" USING ((("uploaded_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text"]))))))) WITH CHECK ((("uploaded_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text"])))))));



ALTER TABLE "public"."workspace_folders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace_folders_team" ON "public"."workspace_folders" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."ai_messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."bookings";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."calendar_events";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."channel_canvas";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."channel_members";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."channels";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."day_sessions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."emails";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."event_types";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."gcal_tokens";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."huddles";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."invitations";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."invoices";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."meeting_transcripts";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."meetings";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."message_attachments";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."message_reactions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."message_reads";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notifications";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."profiles";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."project_priorities";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."stripe_tokens";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."task_comments";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."tasks";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."time_sessions";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."add_all_members_to_channel"("p_channel_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."add_all_members_to_channel"("p_channel_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_all_members_to_channel"("p_channel_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_manage_project"("p_project_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_manage_project"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_manage_project"("p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_group_dm"("p_member_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."create_group_dm"("p_member_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_group_dm"("p_member_ids" "uuid"[]) TO "service_role";



GRANT ALL ON TABLE "public"."invitations" TO "anon";
GRANT ALL ON TABLE "public"."invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."invitations" TO "service_role";



GRANT ALL ON FUNCTION "public"."create_invitation"("p_email" "text", "p_role" "public"."user_role", "p_full_name" "text", "p_invite_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_invitation"("p_email" "text", "p_role" "public"."user_role", "p_full_name" "text", "p_invite_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_invitation"("p_email" "text", "p_role" "public"."user_role", "p_full_name" "text", "p_invite_method" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."current_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."current_user_client_link"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_client_link"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_client_link"() TO "service_role";



GRANT ALL ON FUNCTION "public"."dm_pair_key"("a" "uuid", "b" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dm_pair_key"("a" "uuid", "b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dm_pair_key"("a" "uuid", "b" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_dm_channel"("other_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_dm_channel"("other_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_dm_channel"("other_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_invitation_token"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_invitation_token"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_invitation_token"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_onboarding_token"("p_client_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_onboarding_token"("p_client_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_onboarding_token"("p_client_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_secret"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_secret"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_secret"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."giant_can_invite"() TO "anon";
GRANT ALL ON FUNCTION "public"."giant_can_invite"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."giant_can_invite"() TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_profile_join_channels"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_profile_join_channels"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_profile_join_channels"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_public_channel"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_public_channel"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_public_channel"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_thread_reply"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_thread_reply"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_thread_reply"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_workspace_files_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_workspace_files_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_workspace_files_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_client_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_client_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_client_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_manager_or_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_manager_or_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_manager_or_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_project_member"("p_project_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_project_member"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_project_member"("p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_project_owner"("p_project_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_project_owner"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_project_owner"("p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lookup_invitation"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."lookup_invitation"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lookup_invitation"("p_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."revoke_invitation"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."revoke_invitation"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_invitation"("p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."send_invitation_email"() TO "anon";
GRANT ALL ON FUNCTION "public"."send_invitation_email"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_invitation_email"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at_live_pages"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at_live_pages"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at_live_pages"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_notification_prefs_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_notification_prefs_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_notification_prefs_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";


















GRANT ALL ON TABLE "public"."ai_conversations" TO "anon";
GRANT ALL ON TABLE "public"."ai_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."ai_folders" TO "anon";
GRANT ALL ON TABLE "public"."ai_folders" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_folders" TO "service_role";



GRANT ALL ON TABLE "public"."ai_messages" TO "anon";
GRANT ALL ON TABLE "public"."ai_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_messages" TO "service_role";



GRANT ALL ON TABLE "public"."bookings" TO "anon";
GRANT ALL ON TABLE "public"."bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."bookings" TO "service_role";



GRANT ALL ON TABLE "public"."brand_kits" TO "anon";
GRANT ALL ON TABLE "public"."brand_kits" TO "authenticated";
GRANT ALL ON TABLE "public"."brand_kits" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON TABLE "public"."channel_canvas" TO "anon";
GRANT ALL ON TABLE "public"."channel_canvas" TO "authenticated";
GRANT ALL ON TABLE "public"."channel_canvas" TO "service_role";



GRANT ALL ON TABLE "public"."channel_members" TO "anon";
GRANT ALL ON TABLE "public"."channel_members" TO "authenticated";
GRANT ALL ON TABLE "public"."channel_members" TO "service_role";



GRANT ALL ON TABLE "public"."channels" TO "anon";
GRANT ALL ON TABLE "public"."channels" TO "authenticated";
GRANT ALL ON TABLE "public"."channels" TO "service_role";



GRANT ALL ON TABLE "public"."chat_sections" TO "anon";
GRANT ALL ON TABLE "public"."chat_sections" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_sections" TO "service_role";



GRANT ALL ON TABLE "public"."client_services" TO "anon";
GRANT ALL ON TABLE "public"."client_services" TO "authenticated";
GRANT ALL ON TABLE "public"."client_services" TO "service_role";



GRANT ALL ON TABLE "public"."client_team_members" TO "anon";
GRANT ALL ON TABLE "public"."client_team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."client_team_members" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."clients_public" TO "anon";
GRANT ALL ON TABLE "public"."clients_public" TO "authenticated";
GRANT ALL ON TABLE "public"."clients_public" TO "service_role";



GRANT ALL ON TABLE "public"."day_sessions" TO "anon";
GRANT ALL ON TABLE "public"."day_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."day_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."email_signatures" TO "anon";
GRANT ALL ON TABLE "public"."email_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."email_signatures" TO "service_role";



GRANT ALL ON TABLE "public"."email_templates" TO "anon";
GRANT ALL ON TABLE "public"."email_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."email_templates" TO "service_role";



GRANT ALL ON TABLE "public"."emails" TO "anon";
GRANT ALL ON TABLE "public"."emails" TO "authenticated";
GRANT ALL ON TABLE "public"."emails" TO "service_role";



GRANT ALL ON TABLE "public"."event_types" TO "anon";
GRANT ALL ON TABLE "public"."event_types" TO "authenticated";
GRANT ALL ON TABLE "public"."event_types" TO "service_role";



GRANT ALL ON TABLE "public"."gcal_tokens" TO "anon";
GRANT ALL ON TABLE "public"."gcal_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."gcal_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."gmail_tokens" TO "anon";
GRANT ALL ON TABLE "public"."gmail_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."gmail_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."hercules_outputs" TO "anon";
GRANT ALL ON TABLE "public"."hercules_outputs" TO "authenticated";
GRANT ALL ON TABLE "public"."hercules_outputs" TO "service_role";



GRANT ALL ON TABLE "public"."huddles" TO "anon";
GRANT ALL ON TABLE "public"."huddles" TO "authenticated";
GRANT ALL ON TABLE "public"."huddles" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_items" TO "anon";
GRANT ALL ON TABLE "public"."invoice_items" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_items" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."live_pages" TO "anon";
GRANT ALL ON TABLE "public"."live_pages" TO "authenticated";
GRANT ALL ON TABLE "public"."live_pages" TO "service_role";



GRANT ALL ON TABLE "public"."magnus_missions" TO "anon";
GRANT ALL ON TABLE "public"."magnus_missions" TO "authenticated";
GRANT ALL ON TABLE "public"."magnus_missions" TO "service_role";



GRANT ALL ON TABLE "public"."meeting_transcripts" TO "anon";
GRANT ALL ON TABLE "public"."meeting_transcripts" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_transcripts" TO "service_role";



GRANT ALL ON TABLE "public"."meetings" TO "anon";
GRANT ALL ON TABLE "public"."meetings" TO "authenticated";
GRANT ALL ON TABLE "public"."meetings" TO "service_role";



GRANT ALL ON TABLE "public"."message_attachments" TO "anon";
GRANT ALL ON TABLE "public"."message_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."message_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."message_reactions" TO "anon";
GRANT ALL ON TABLE "public"."message_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."message_reads" TO "anon";
GRANT ALL ON TABLE "public"."message_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reads" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."mrr_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."mrr_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."mrr_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."notes" TO "anon";
GRANT ALL ON TABLE "public"."notes" TO "authenticated";
GRANT ALL ON TABLE "public"."notes" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."project_fields" TO "anon";
GRANT ALL ON TABLE "public"."project_fields" TO "authenticated";
GRANT ALL ON TABLE "public"."project_fields" TO "service_role";



GRANT ALL ON TABLE "public"."project_members" TO "anon";
GRANT ALL ON TABLE "public"."project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."project_members" TO "service_role";



GRANT ALL ON TABLE "public"."project_priorities" TO "anon";
GRANT ALL ON TABLE "public"."project_priorities" TO "authenticated";
GRANT ALL ON TABLE "public"."project_priorities" TO "service_role";



GRANT ALL ON TABLE "public"."project_views" TO "anon";
GRANT ALL ON TABLE "public"."project_views" TO "authenticated";
GRANT ALL ON TABLE "public"."project_views" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."recordings" TO "anon";
GRANT ALL ON TABLE "public"."recordings" TO "authenticated";
GRANT ALL ON TABLE "public"."recordings" TO "service_role";



GRANT ALL ON TABLE "public"."share_feedback" TO "anon";
GRANT ALL ON TABLE "public"."share_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."share_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."share_packs" TO "anon";
GRANT ALL ON TABLE "public"."share_packs" TO "authenticated";
GRANT ALL ON TABLE "public"."share_packs" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_config" TO "anon";
GRANT ALL ON TABLE "public"."stripe_config" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_config" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_tokens" TO "anon";
GRANT ALL ON TABLE "public"."stripe_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."subtasks" TO "anon";
GRANT ALL ON TABLE "public"."subtasks" TO "authenticated";
GRANT ALL ON TABLE "public"."subtasks" TO "service_role";



GRANT ALL ON TABLE "public"."task_comments" TO "anon";
GRANT ALL ON TABLE "public"."task_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."task_comments" TO "service_role";



GRANT ALL ON TABLE "public"."task_subtasks" TO "anon";
GRANT ALL ON TABLE "public"."task_subtasks" TO "authenticated";
GRANT ALL ON TABLE "public"."task_subtasks" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."time_sessions" TO "anon";
GRANT ALL ON TABLE "public"."time_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."time_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."unread_counts" TO "anon";
GRANT ALL ON TABLE "public"."unread_counts" TO "authenticated";
GRANT ALL ON TABLE "public"."unread_counts" TO "service_role";



GRANT ALL ON TABLE "public"."vulcan_videos" TO "anon";
GRANT ALL ON TABLE "public"."vulcan_videos" TO "authenticated";
GRANT ALL ON TABLE "public"."vulcan_videos" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_files" TO "anon";
GRANT ALL ON TABLE "public"."workspace_files" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_files" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_files_stats" TO "anon";
GRANT ALL ON TABLE "public"."workspace_files_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_files_stats" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_folders" TO "anon";
GRANT ALL ON TABLE "public"."workspace_folders" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_folders" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop policy "live_pages_public_read" on "public"."live_pages";

drop policy "transcripts_insert_all" on "public"."meeting_transcripts";

drop policy "transcripts_select_all" on "public"."meeting_transcripts";

drop policy "meetings_select_by_token" on "public"."meetings";

drop policy "Public can view share packs" on "public"."share_packs";


  create policy "live_pages_public_read"
  on "public"."live_pages"
  as permissive
  for select
  to anon, authenticated
using ((is_published = true));



  create policy "transcripts_insert_all"
  on "public"."meeting_transcripts"
  as permissive
  for insert
  to anon, authenticated
with check (true);



  create policy "transcripts_select_all"
  on "public"."meeting_transcripts"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "meetings_select_by_token"
  on "public"."meetings"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Public can view share packs"
  on "public"."share_packs"
  as permissive
  for select
  to anon, authenticated
using (true);


CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


  create policy "Authenticated delete on vulcan-images"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using ((bucket_id = 'vulcan-images'::text));



  create policy "Authenticated write on vulcan-images"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'vulcan-images'::text));



  create policy "Authenticated write on vulcan-videos"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'vulcan-videos'::text));



  create policy "Avatars delete own folder"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Avatars insert own folder"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Avatars public read"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'avatars'::text));



  create policy "Avatars update own folder"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Public read on vulcan-images"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'vulcan-images'::text));



  create policy "Public read on vulcan-videos"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'vulcan-videos'::text));



  create policy "chat_attachments_authenticated_insert"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'chat-attachments'::text));



  create policy "chat_attachments_authenticated_read"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using ((bucket_id = 'chat-attachments'::text));



  create policy "chat_attachments_owner_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'chat-attachments'::text) AND (owner = auth.uid())));



  create policy "recordings_delete_own"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'recordings'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "recordings_read"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'recordings'::text));



  create policy "recordings_read_public"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'recordings'::text));



  create policy "recordings_update_own"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'recordings'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "recordings_upload"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'recordings'::text));



  create policy "recordings_upload_own"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'recordings'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "voice_notes_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'voice-notes'::text) AND (owner = auth.uid())));



  create policy "voice_notes_read"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'voice-notes'::text));



  create policy "voice_notes_upload"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'voice-notes'::text));



  create policy "workspace_files_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'workspace-files'::text) AND (owner = auth.uid())));



  create policy "workspace_files_read"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'workspace-files'::text));



  create policy "workspace_files_update"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'workspace-files'::text) AND (owner = auth.uid())));



  create policy "workspace_files_upload"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'workspace-files'::text));



