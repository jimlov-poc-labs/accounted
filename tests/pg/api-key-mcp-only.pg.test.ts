import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * api_keys.mcp_only (migration 20260924120000).
 *
 * The enforcement is TypeScript (lib/auth/api-keys.ts validateApiKey refuses
 * the key on every surface but MCP). What must hold in the database:
 *   1. the column defaults to false, so every existing key keeps REST;
 *   2. validate_and_increment_api_key returns it, with exactly one signature
 *      (a new return column is a DROP + CREATE; a second overload would make
 *      PostgREST answer 300 on the ambiguity);
 *   3. EXECUTE stays service_role only after the re-create;
 *   4. a JWT session may set it at INSERT but never flip it afterwards.
 */

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function seedOwner() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

describe('api_keys.mcp_only (pg)', () => {
  it('defaults to false so pre-existing keys are unaffected', async () => {
    const { userId, companyId } = await seedOwner()
    // Column omitted on purpose: this pins the DATABASE DEFAULT.
    const { rows } = await getPool().query<{ mcp_only: boolean }>(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, 'gnubok_sk_test', 'Default key', $4)
       RETURNING mcp_only`,
      [userId, companyId, sha256(randomUUID()), ['reports:read']],
    )
    expect(rows[0]!.mcp_only).toBe(false)
  })

  it('rejects NULL', async () => {
    const { userId, companyId } = await seedOwner()
    await expect(
      getPool().query(
        `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, mcp_only)
         VALUES ($1, $2, $3, 'gnubok_sk_test', 'Null key', $4, NULL)`,
        [userId, companyId, sha256(randomUUID()), ['reports:read']],
      ),
    ).rejects.toMatchObject({ code: '23502' })
  })

  it('validate_and_increment_api_key returns the flag and has exactly one signature', async () => {
    const { userId, companyId } = await seedOwner()
    const keyHash = sha256(randomUUID())
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, mcp_only)
       VALUES ($1, $2, $3, 'gnubok_sk_test', 'Proposer', $4, true)`,
      [userId, companyId, keyHash, ['bookkeeping:write']],
    )

    const overloads = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'validate_and_increment_api_key'`,
    )
    expect(overloads.rows[0]!.n).toBe(1)

    const { rows } = await getPool().query<{
      mcp_only: boolean
      rate_limited: boolean
      unattended_commit_limit: string | null
    }>(`SELECT * FROM public.validate_and_increment_api_key($1)`, [keyHash])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.mcp_only).toBe(true)
    expect(rows[0]!.rate_limited).toBe(false)
    // The previous return columns survive the re-create.
    expect(rows[0]!.unattended_commit_limit).toBeNull()
  })

  it('keeps EXECUTE service_role only after the re-create', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authed: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.validate_and_increment_api_key(text)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.validate_and_increment_api_key(text)', 'EXECUTE') AS authed,
              has_function_privilege('service_role', 'public.validate_and_increment_api_key(text)', 'EXECUTE') AS service`,
    )
    expect(rows[0]).toEqual({ anon: false, authed: false, service: true })
  })

  it('lets a JWT session create an MCP-only key', async () => {
    const { userId, companyId } = await seedOwner()
    // withUserContext rolls back, so this only proves the INSERT is allowed.
    await withUserContext(userId, async (client) => {
      const res = await client.query<{ mcp_only: boolean }>(
        `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, mcp_only)
         VALUES ($1, $2, $3, 'gnubok_sk_mcponly', 'Proposer', ARRAY['bookkeeping:write'], true)
         RETURNING mcp_only`,
        [userId, companyId, sha256(randomUUID())],
      )
      expect(res.rows[0]!.mcp_only).toBe(true)
    })
  })

  it('refuses a JWT session flipping the flag in either direction', async () => {
    const { userId, companyId } = await seedOwner()
    for (const initial of [true, false]) {
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, mcp_only)
         VALUES ($1, $2, $3, 'gnubok_sk_mcponly', 'Flip target', ARRAY['bookkeeping:write'], $4)
         RETURNING id`,
        [userId, companyId, sha256(randomUUID()), initial],
      )
      const keyId = rows[0]!.id
      await expect(
        withUserContext(userId, (client) =>
          client.query(`UPDATE public.api_keys SET mcp_only = $2 WHERE id = $1`, [keyId, !initial]),
        ),
      ).rejects.toMatchObject({ code: '42501' })

      // Revoking stays possible for the owner: that is the settings route's job.
      await withUserContext(userId, async (client) => {
        const res = await client.query(
          `UPDATE public.api_keys SET revoked_at = now() WHERE id = $1 RETURNING id`,
          [keyId],
        )
        expect(res.rows).toHaveLength(1)
      })
    }
  })
})
