import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

// ── Mocks ──────────────────────────────────────────────────────────
// withRouteContext resolves auth via requireAuth (createClient under the hood),
// the active company via getActiveCompanyId, and the write gate via
// requireWritePermission. Mock all three so we can drive each branch.

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
/** The static route's second argument, as Next.js hands it over. */
const noParams = { params: Promise.resolve({}) as Promise<Record<string, never>> }

// Records the payload passed to .insert(), and lets us program the count
// returned by the quota pre-check and the row returned by the insert.
function setupFrom(opts: {
  count?: number | null
  insertResult?: { data?: unknown; error?: unknown }
}) {
  const insertSpy = vi.fn()

  mockSupabase.from.mockImplementation(() => {
    // The quota pre-check: .select(..., { head: true }).eq().is() → resolves
    // to { count }. The insert: .insert().select().single() → resolves to the
    // row. We expose both via a single chainable proxy whose terminal value
    // depends on whether insert() was called.
    let isInsert = false
    const result = () =>
      isInsert
        ? Promise.resolve({
            data: opts.insertResult?.data ?? null,
            error: opts.insertResult?.error ?? null,
          })
        : Promise.resolve({ count: opts.count ?? 0, data: null, error: null })

    const chain: Record<string, unknown> = {}
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result() as unknown)
        }
        if (prop === 'insert') {
          return (payload: unknown) => {
            isInsert = true
            insertSpy(payload)
            return new Proxy(chain, handler)
          }
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => result()
        }
        return () => new Proxy(chain, handler)
      },
    }
    return new Proxy(chain, handler)
  })

  return { insertSpy }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  getActiveCompanyIdMock.mockResolvedValue('company-1')
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('POST /api/settings/api-keys', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['reports:read'] },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for an invalid scope', async () => {
    setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'k', scopes: ['totally:bogus'] },
      }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('API_KEY_SCOPE_INVALID')
  })

  it('returns 400 for the reserved OAuth marker name (would fake a Claude connection)', async () => {
    const { insertSpy } = setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: ' MCP-klient (OAuth) ', scopes: ['reports:read'] },
      }),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { field: string; reason: string } }
    }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ field: 'name', reason: 'reserved' })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 409 API_KEY_SOD_CONFLICT for stage+approve without acknowledgement', async () => {
    setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: {
          name: 'k',
          scopes: ['invoices:write', 'pending_operations:approve'],
        },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { conflicting_scope: string; approve_scope: string } }
    }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('API_KEY_SOD_CONFLICT')
    expect(body.error.details.conflicting_scope).toBe('invoices:write')
    expect(body.error.details.approve_scope).toBe('pending_operations:approve')
  })

  it('records sod_acknowledged_at/by in the insert when acknowledge_sod is true', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: {
        data: {
          id: 'ak-1',
          key_prefix: 'gnubok_sk_abcd',
          name: 'k',
          scopes: ['invoices:write', 'pending_operations:approve'],
          created_at: '2026-06-05T10:00:00Z',
        },
      },
    })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: {
          name: 'k',
          scopes: ['invoices:write', 'pending_operations:approve'],
          acknowledge_sod: true,
        },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: { key: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.key).toMatch(/^gnubok_sk_/)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.sod_acknowledged_by).toBe('user-1')
    expect(typeof payload.sod_acknowledged_at).toBe('string')
    // ISO timestamp
    expect(payload.sod_acknowledged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('creates a clean key without approve scope and does not set SoD fields', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: {
        data: {
          id: 'ak-2',
          key_prefix: 'gnubok_sk_efgh',
          name: 'reader',
          scopes: ['reports:read'],
          created_at: '2026-06-05T10:00:00Z',
        },
      },
    })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'reader', scopes: ['reports:read'] },
      }),
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(200)

    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('sod_acknowledged_at')
    expect(payload).not.toHaveProperty('sod_acknowledged_by')
    expect(payload.scopes).toEqual(['reports:read'])
    // Default mode is live, bound to the active company.
    expect(payload.mode).toBe('live')
    expect(payload.company_id).toBe('company-1')
    // Not MCP-only unless asked for: existing integrations keep REST.
    expect(payload.mcp_only).toBe(false)
  })

  it('stores mcp_only: true when the body opts in', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: {
        data: {
          id: 'ak-4',
          key_prefix: 'gnubok_sk_mcp1',
          name: 'proposer',
          scopes: ['bookkeeping:write', 'reports:read'],
          mode: 'live',
          mcp_only: true,
          created_at: '2026-09-24T10:00:00Z',
        },
      },
    })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'proposer', scopes: ['bookkeeping:write', 'reports:read'], mcp_only: true },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { mcp_only: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.mcp_only).toBe(true)
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.mcp_only).toBe(true)
  })

  it('treats a truthy non-boolean mcp_only as a normal key (strict opt-in)', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: { data: { id: 'ak-5', key_prefix: 'gnubok_sk_x', name: 'x', scopes: ['reports:read'] } },
    })
    await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'x', scopes: ['reports:read'], mcp_only: 'yes' },
      }),
      noParams,
    )
    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.mcp_only).toBe(false)
  })

  it('refuses an MCP-only key with pending_operations:approve, even with acknowledge_sod', async () => {
    const { insertSpy } = setupFrom({ count: 0 })
    for (const scopes of [
      ['bookkeeping:write', 'pending_operations:approve'],
      // Approve without any staging scope is still refused: the flag means
      // the key cannot settle a pending operation at all.
      ['reports:read', 'pending_operations:approve'],
    ]) {
      const res = await POST(
        createMockRequest('/api/settings/api-keys', {
          method: 'POST',
          body: { name: 'self-approver', scopes, mcp_only: true, acknowledge_sod: true },
        }),
        noParams,
      )
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details: { field: string; reason: string } }
      }>(res)
      expect(status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details).toMatchObject({ field: 'scopes', reason: 'mcp_only_cannot_approve' })
    }
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('keeps the SoD acknowledgement path for an ordinary stage+approve key', async () => {
    setupFrom({ count: 0 })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'ordinary', scopes: ['bookkeeping:write', 'pending_operations:approve'] },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('API_KEY_SOD_CONFLICT')
  })

  it('creates a test key bound to the active company with mode=test', async () => {
    const { insertSpy } = setupFrom({
      count: 0,
      insertResult: {
        data: {
          id: 'ak-3',
          key_prefix: 'gnubok_sk_test_abc',
          name: 'pilot',
          scopes: ['reports:read'],
          mode: 'test',
          created_at: '2026-06-05T10:00:00Z',
        },
      },
    })
    const res = await POST(
      createMockRequest('/api/settings/api-keys', {
        method: 'POST',
        body: { name: 'pilot', scopes: ['reports:read'], mode: 'test' },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: { key: string } }>(res)
    expect(status).toBe(200)
    // Real generateApiKey('test') runs: the returned secret carries the infix.
    expect(body.data.key).toMatch(/^gnubok_sk_test_/)

    const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.mode).toBe('test')
    // Test keys are simulation-only: they bind to the active company (the v1
    // wrapper forces dry-run so they never persist).
    expect(payload.company_id).toBe('company-1')
  })
})
