-- Luke: "we need to give option invite if not in list invite user email ... what if partner is
-- not on giant app yet" — Access could previously only grant access to an EXISTING profile.
-- This lets staff invite someone who has no Giant account at all yet, and have them land with
-- the right White Label company access automatically the moment they accept.

ALTER TABLE "public"."invitations"
    ADD COLUMN IF NOT EXISTS "white_label_company_id" "uuid" REFERENCES "public"."white_label_companies"("id") ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "white_label_access_level" "text" CHECK ("white_label_access_level" IN ('read_only', 'can_edit'));

-- handle_new_user() already turns an accepted invitation into a real profile — this just adds
-- one more step when the invitation carries a white_label_company_id: grant that company access
-- immediately, so the person never has a gap where they're signed up but can't see anything yet.
CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO 'public'
    AS $$
DECLARE
  v_profile_count integer;
  v_invited_role  user_role;
  v_invitation_id uuid;
  v_full_name     text;
  v_is_admin_invite boolean;
  v_wl_company_id uuid;
  v_wl_access_level text;
  v_invited_by uuid;
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
  SELECT id, role, white_label_company_id, white_label_access_level, invited_by
    INTO v_invitation_id, v_invited_role, v_wl_company_id, v_wl_access_level, v_invited_by
    FROM public.invitations
   WHERE lower(email) = lower(NEW.email)
     AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1;

  IF v_invitation_id IS NOT NULL THEN
    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (NEW.id, NEW.email, v_full_name, v_invited_role);
    UPDATE public.invitations SET accepted_at = now(), accepted_by = NEW.id
     WHERE id = v_invitation_id;
    IF v_wl_company_id IS NOT NULL THEN
      INSERT INTO public.white_label_company_members (company_id, profile_id, access_level, added_by)
      VALUES (v_wl_company_id, NEW.id, COALESCE(v_wl_access_level, 'read_only'), v_invited_by)
      ON CONFLICT (company_id, profile_id) DO NOTHING;
    END IF;
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
END
$$;
