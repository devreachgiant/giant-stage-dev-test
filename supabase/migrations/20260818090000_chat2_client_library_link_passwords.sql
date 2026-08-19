-- Removes the duplicate credential store introduced by 20260817120000.
--
-- That migration gave chat2_client_library its own AES-GCM secret columns, which
-- meant a credential could exist twice: once in the vault and once in
-- password_entries. Two rows for one secret is two rotations to remember, and
-- only one of them was reachable from the Passwords screen — so the copy in the
-- vault could silently go stale and nobody would know which one was current.
--
-- A library login now REFERENCES the canonical password_entries row instead of
-- carrying its own copy. One credential, one row, rotate it anywhere.
--
-- ACCESS NOTE — this deliberately changes who can see a stored credential.
-- Before: anyone who could see the client's library (i.e. a member of any of that
-- client's threads). After: whatever the password folder says, which is the
-- password manager's own model. Managers and owners are unaffected (they see all
-- folders either way). Non-manager staff need folder membership. That is the
-- point of consolidating: credentials should be governed by the credential
-- system, not by chat-thread membership.

ALTER TABLE "public"."chat2_client_library"
    ADD COLUMN IF NOT EXISTS "password_entry_id" "uuid"
    REFERENCES "public"."password_entries"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_chat2_client_library_password_entry"
    ON "public"."chat2_client_library" ("password_entry_id");

-- Move anything already stored locally. The ciphertext is re-homed verbatim —
-- same key, same algorithm — so nothing is re-encrypted and nothing is lost.
DO $$
DECLARE
    r RECORD;
    v_folder_id uuid;
    v_entry_id uuid;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat2_client_library'
          AND column_name = 'secret_ciphertext'
    ) THEN
        RETURN; -- already migrated
    END IF;

    FOR r IN EXECUTE
        'SELECT id, client_id, title, url, username, created_by,
                secret_ciphertext, secret_iv, secret_auth_tag
           FROM public.chat2_client_library
          WHERE secret_ciphertext IS NOT NULL'
    LOOP
        -- One vault folder per client, reused across rows. ''shared'' rather than
        -- ''public'': a client credential is not something every staff member
        -- should get by default.
        SELECT f.id INTO v_folder_id
          FROM public.password_folders f
         WHERE f.client_id = r.client_id AND f.name = 'Chat Vault'
         LIMIT 1;

        IF v_folder_id IS NULL THEN
            INSERT INTO public.password_folders (name, client_id, created_by, visibility)
            VALUES ('Chat Vault', r.client_id, r.created_by, 'shared')
            RETURNING id INTO v_folder_id;
        END IF;

        -- Whoever saved it keeps access after the move.
        IF r.created_by IS NOT NULL THEN
            INSERT INTO public.password_folder_members (folder_id, profile_id, added_by)
            VALUES (v_folder_id, r.created_by, r.created_by)
            ON CONFLICT DO NOTHING;
        END IF;

        INSERT INTO public.password_entries
            (folder_id, title, username, url, password_ciphertext, password_iv, password_auth_tag, created_by)
        VALUES
            (v_folder_id, r.title, r.username, r.url,
             r.secret_ciphertext, r.secret_iv, r.secret_auth_tag, r.created_by)
        RETURNING id INTO v_entry_id;

        EXECUTE 'UPDATE public.chat2_client_library SET password_entry_id = $1 WHERE id = $2'
          USING v_entry_id, r.id;
    END LOOP;
END $$;

-- With the data moved, the vault can no longer hold a secret at all. Dropping the
-- columns is what makes the duplication impossible rather than merely discouraged.
ALTER TABLE "public"."chat2_client_library" DROP CONSTRAINT IF EXISTS "chat2_client_library_secret_complete";
ALTER TABLE "public"."chat2_client_library" DROP COLUMN IF EXISTS "secret_ciphertext";
ALTER TABLE "public"."chat2_client_library" DROP COLUMN IF EXISTS "secret_iv";
ALTER TABLE "public"."chat2_client_library" DROP COLUMN IF EXISTS "secret_auth_tag";

-- ROLLBACK. This does NOT restore the local secret columns — the credentials now
-- live in password_entries and that is where they should stay. It only unlinks:
--   ALTER TABLE "public"."chat2_client_library" DROP COLUMN IF EXISTS "password_entry_id";
-- The password_entries rows and the per-client 'Chat Vault' folders created by the
-- migration above are deliberately left in place; deleting them would destroy
-- credentials, which a schema rollback has no business doing.
