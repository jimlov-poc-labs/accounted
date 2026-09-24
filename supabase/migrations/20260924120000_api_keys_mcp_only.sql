-- api_keys.mcp_only: a key that authenticates on the MCP server and nowhere else.
--
-- Scopes on a key apply whatever door it is presented at. Through MCP a write
-- is staged as a pending_operation and waits for a human (or a key holding
-- pending_operations:approve); the same key against REST /api/v1/** writes
-- directly: bookkeeping:write reverses, corrects, locks and closes periods,
-- imports SIE and commits drafts, transactions:write imports and categorizes.
-- unattended_commit_limit is by its own definition not a security boundary.
-- There was therefore no way to mint a key that can only PROPOSE.
--
-- The flag is enforced in TypeScript at the one place every bearer-key path
-- goes through (lib/auth/api-keys.ts validateApiKey): only the MCP server
-- asserts the 'mcp' surface, every other caller defaults to 'rest', so a new
-- route that authenticates a key is covered without knowing the flag exists.
-- The database's half is returning the flag from the one function that
-- matches the key hash, so the value is bound to a DB-verified credential.
--
-- NOT NULL DEFAULT false: every existing key keeps its behaviour, and no read
-- can see a third state. Frozen against JWT-session UPDATEs like `mode`: a
-- proposal-only key must not be widenable after the fact by anything but
-- minting a new key.
--
-- pg-test: tests/pg/api-key-mcp-only.pg.test.ts

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS mcp_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.api_keys.mcp_only IS
  'When true the key authenticates only on the MCP server (where writes are staged for approval); REST /api/v1, /api/events and every other bearer-key surface answer 403 API_KEY_MCP_ONLY. Set at creation, immutable from user sessions.';

-- validate_and_increment_api_key: body copied VERBATIM from
-- 20260902090000_security_api_keys_identity_and_provider_token_policies.sql
-- (the latest definition: rotation grace, membership fail-closed, fixed
-- search_path) with exactly one change: mcp_only joins the RETURNS TABLE and
-- is returned in all three RETURN QUERY branches. A new return column changes
-- the function's type, so it is DROP + CREATE (CREATE OR REPLACE cannot), and
-- the grants from 20260902090000 are re-applied below.
DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text,
  unattended_commit_limit numeric,
  mcp_only boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
  v_mode text;
  v_unattended_commit_limit numeric;
  v_mcp_only boolean;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit, ak.mcp_only
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit, v_mcp_only
  FROM public.api_keys ak
  WHERE ak.revoked_at IS NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
  FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;  -- no live match (incl. expired grace): caller returns 401, as before
  END IF;

  -- A key outlives neither the membership it was minted under nor the company
  -- itself. Company-less keys (OAuth lazy bind) have nothing to check yet.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = v_user_id
      AND cm.company_id = v_company_id
  ) THEN
    RETURN;  -- treated as an unknown key: 401 upstream
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit, v_mcp_only;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_mcp_only;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_mcp_only;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

-- api_keys_guard_jwt_writes: body copied VERBATIM from 20260902090000 with one
-- change: mcp_only joins the columns a JWT session may not UPDATE. INSERT is
-- unchanged, so the settings route (a user session) can still set it at
-- creation; the service role is unaffected as before.
CREATE OR REPLACE FUNCTION public.api_keys_guard_jwt_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- service_role, pg_cron, migrations and the pg-real harness carry no
  -- end-user role claim: nothing to enforce.
  IF v_jwt_role NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'api_keys: user_id must be the calling user'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.refresh_token_hash IS NOT NULL
       OR NEW.previous_key_hash IS NOT NULL
       OR NEW.previous_refresh_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'api_keys: refresh-token material is set only by the OAuth token endpoint'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.mcp_only IS DISTINCT FROM OLD.mcp_only
     OR NEW.refresh_token_hash IS DISTINCT FROM OLD.refresh_token_hash
     OR NEW.previous_key_hash IS DISTINCT FROM OLD.previous_key_hash
     OR NEW.previous_key_expires_at IS DISTINCT FROM OLD.previous_key_expires_at
     OR NEW.previous_refresh_token_hash IS DISTINCT FROM OLD.previous_refresh_token_hash
     OR NEW.previous_refresh_expires_at IS DISTINCT FROM OLD.previous_refresh_expires_at THEN
    RAISE EXCEPTION 'api_keys: identity and credential columns are immutable from a user session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
