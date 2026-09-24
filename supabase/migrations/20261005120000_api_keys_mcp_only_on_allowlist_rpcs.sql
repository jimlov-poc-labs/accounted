-- Re-assert api_keys.mcp_only on top of the upstream per-key company allowlist.
-- pg-test: tests/pg/api-key-mcp-only.pg.test.ts
--
-- 20260924120000_api_keys_mcp_only added api_keys.mcp_only and made
-- validate_and_increment_api_key return it. The upstream migrations
-- 20260928112721 and 20260928112724 then DROP + CREATE that function from a
-- body that predates mcp_only, so after them the function no longer returns
-- the column and validateApiKey (which reads an absent mcp_only as MCP-only,
-- fail closed) would refuse every key on REST. Likewise
-- create_api_key_with_allowlist (the settings route's create path since
-- 20260928112722) has no way to set mcp_only, so a key minted through it
-- would silently be a normal key.
--
-- This migration is the superset, with a version newer than every upstream
-- one so that it is applied last on a fresh database and as a pending
-- migration on one that already has 20260924120000/130000:
--   1. mcp_only column (IF NOT EXISTS: a no-op where 20260924120000 ran).
--   2. validate_and_increment_api_key: the 20260928112724 body VERBATIM plus
--      mcp_only in RETURNS TABLE and in all three RETURN QUERY branches.
--   3. create_api_key_with_allowlist: the 20260928112724 body VERBATIM plus a
--      trailing p_mcp_only boolean DEFAULT false written to api_keys.mcp_only.
-- The CHECK api_keys_mcp_only_no_approve (20260924130000) and the JWT-write
-- guard (20260924120000) are untouched by upstream and need no repeat.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP FUNCTION IF EXISTS before each
-- CREATE, grants re-applied. Running it twice, or on a database that already
-- has the old versions applied, leaves the same end state.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS mcp_only boolean NOT NULL DEFAULT false;

-- 1. validate_and_increment_api_key ------------------------------------------

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
  allowed_company_ids uuid[],
  read_only_company_ids uuid[],
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
  v_allowed_company_ids uuid[];
  v_read_only_company_ids uuid[];
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

  -- Per-key company allowlist: NULL when the key has no rows (every
  -- membership is reachable), else the listed ids in creation order. The
  -- read-only subset rides the same scan: NULL when no row is read-only.
  SELECT array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id),
         array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id)
           FILTER (WHERE akc.access = 'read')
  INTO v_allowed_company_ids, v_read_only_company_ids
  FROM public.api_key_companies akc
  WHERE akc.api_key_id = v_id;

  -- A restricted key's default must be reachable: when the stored default is
  -- outside the allowlist (or absent), the first allowed company the user is
  -- still a live member of takes its place. Nothing left means the key
  -- reaches nothing: treated as an unknown key, like the membership block.
  IF v_allowed_company_ids IS NOT NULL
     AND (v_company_id IS NULL OR v_company_id <> ALL (v_allowed_company_ids)) THEN
    SELECT akc.company_id
    INTO v_company_id
    FROM public.api_key_companies akc
    JOIN public.company_members cm
      ON cm.company_id = akc.company_id AND cm.user_id = v_user_id
    JOIN public.companies c
      ON c.id = akc.company_id AND c.archived_at IS NULL
    WHERE akc.api_key_id = v_id
    ORDER BY akc.created_at, akc.company_id
    LIMIT 1;

    IF v_company_id IS NULL THEN
      RETURN;  -- allowlist names no company the user still belongs to: 401 upstream
    END IF;
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
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids, v_mcp_only;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids, v_mcp_only;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids, v_mcp_only;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

-- 2. create_api_key_with_allowlist: mcp_only at creation ----------------------
--
-- The 14-parameter function is dropped first: PostgREST resolves functions by
-- argument names, and two overloads that both accept the old names would make
-- every existing call ambiguous (the same reason 20260928112724 dropped its
-- predecessor). p_mcp_only is last and DEFAULT false, so a caller that does
-- not name it keeps creating a normal key.
DROP FUNCTION IF EXISTS public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[], uuid[]
);

CREATE FUNCTION public.create_api_key_with_allowlist(
  p_user_id uuid,
  p_company_id uuid,
  p_key_hash text,
  p_key_prefix text,
  p_name text,
  p_scopes text[],
  p_mode text,
  p_client text,
  p_refresh_token_hash text,
  p_sod_acknowledged_at timestamptz,
  p_sod_acknowledged_by uuid,
  p_unattended_commit_limit numeric,
  p_company_ids uuid[],
  p_read_only_company_ids uuid[] DEFAULT NULL,
  p_mcp_only boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_ids uuid[];
  v_read_only_ids uuid[];
  v_not_member uuid[];
  v_outside uuid[];
  v_key_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'create_api_key_with_allowlist: p_user_id is required'
      USING ERRCODE = '22004';
  END IF;

  -- Normalise the allowlist: drop NULL elements, collapse duplicates, keep
  -- first-occurrence order. Nothing left means unrestricted.
  SELECT array_agg(d.cid ORDER BY d.first_ord)
  INTO v_company_ids
  FROM (
    SELECT u.cid, min(u.ord) AS first_ord
    FROM unnest(p_company_ids) WITH ORDINALITY AS u(cid, ord)
    WHERE u.cid IS NOT NULL
    GROUP BY u.cid
  ) AS d;

  -- Normalise the read-only set the same way. Nothing left means none.
  SELECT array_agg(DISTINCT r.cid)
  INTO v_read_only_ids
  FROM unnest(p_read_only_company_ids) AS r(cid)
  WHERE r.cid IS NOT NULL;

  IF v_read_only_ids IS NOT NULL THEN
    IF v_company_ids IS NULL THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: read-only companies require a company allowlist'
        USING ERRCODE = '23514';
    END IF;

    SELECT array_agg(r.cid ORDER BY r.cid)
    INTO v_outside
    FROM unnest(v_read_only_ids) AS r(cid)
    WHERE r.cid <> ALL (v_company_ids);
    IF v_outside IS NOT NULL THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: read-only companies % are not in the allowlist',
        v_outside
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_company_ids IS NOT NULL THEN
    -- Every allowed company is a live membership of the key's user.
    SELECT array_agg(a.cid ORDER BY a.cid)
    INTO v_not_member
    FROM unnest(v_company_ids) AS a(cid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
      WHERE cm.user_id = p_user_id
        AND cm.company_id = a.cid
    );
    IF v_not_member IS NOT NULL THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: user % is not a live member of company %',
        p_user_id, v_not_member
        USING ERRCODE = '42501';
    END IF;

    -- The default company must be inside the allowlist.
    IF p_company_id IS NULL OR p_company_id <> ALL (v_company_ids) THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: default company % is not in the allowlist',
        p_company_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.api_keys (
    user_id,
    company_id,
    key_hash,
    key_prefix,
    name,
    scopes,
    mode,
    client,
    refresh_token_hash,
    sod_acknowledged_at,
    sod_acknowledged_by,
    unattended_commit_limit,
    mcp_only
  ) VALUES (
    p_user_id,
    p_company_id,
    p_key_hash,
    p_key_prefix,
    COALESCE(p_name, 'Unnamed key'),
    p_scopes,
    COALESCE(p_mode, 'live'),
    p_client,
    p_refresh_token_hash,
    p_sod_acknowledged_at,
    p_sod_acknowledged_by,
    p_unattended_commit_limit,
    COALESCE(p_mcp_only, false)
  )
  RETURNING id INTO v_key_id;

  IF v_company_ids IS NOT NULL THEN
    INSERT INTO public.api_key_companies (api_key_id, company_id, access)
    SELECT v_key_id,
           a.cid,
           CASE WHEN a.cid = ANY (COALESCE(v_read_only_ids, '{}'::uuid[])) THEN 'read' ELSE 'write' END
    FROM unnest(v_company_ids) WITH ORDINALITY AS a(cid, ord)
    ORDER BY a.ord;
  END IF;

  RETURN v_key_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[], uuid[], boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[], uuid[], boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';
