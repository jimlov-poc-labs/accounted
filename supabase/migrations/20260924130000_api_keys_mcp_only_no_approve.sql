-- An MCP-only key can never hold pending_operations:approve.
--
-- mcp_only (20260924120000) exists so a key can only PROPOSE: its writes are
-- staged pending_operations that a person approves. With approve on the same
-- key it could approve its own proposals over MCP, which is the one thing the
-- flag is meant to rule out. The settings route refuses the combination
-- (VALIDATION_ERROR, reason mcp_only_cannot_approve) regardless of the SoD
-- acknowledgement; this CHECK is the storage half, so no path (a PostgREST
-- update by an admin under RLS, a service-role script, a future route) can
-- add approve to an MCP-only key or flag an approving key MCP-only.
--
-- scopes is text[] and nullable (NULL = legacy key, read as the read-only
-- DEFAULT_SCOPES). `= ANY(NULL)` is NULL, so the COALESCE makes the intent
-- explicit: a NULL-scope key holds no approve scope.
--
-- Validated at once, not NOT VALID: mcp_only was added in the previous
-- migration with DEFAULT false, so no existing row can violate it, and the
-- table is small (hundreds of rows).
--
-- pg-test: tests/pg/api-key-mcp-only.pg.test.ts

ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_mcp_only_no_approve;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_mcp_only_no_approve
  CHECK (NOT (mcp_only AND COALESCE('pending_operations:approve' = ANY (scopes), false)));

NOTIFY pgrst, 'reload schema';
