/**
 * api_keys.mcp_only across the real surfaces (migration 20260924120000).
 *
 * validateApiKey is NOT mocked here: only the service-role client underneath
 * it is, so each surface runs the same check it runs in production. The
 * claim under test is the fail-closed shape: REST /api/v1 and /api/events
 * never pass a surface, so an MCP-only key is refused there with 403
 * API_KEY_MCP_ONLY before any handler runs, while the MCP server (the one
 * caller asserting 'mcp') accepts the same key. An ordinary key is accepted
 * on every surface.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const state = vi.hoisted(() => ({
  mcpOnly: true as boolean,
  rpc: vi.fn(),
}))

function rpcRow() {
  return {
    user_id: 'user-1',
    company_id: '11111111-1111-4111-8111-111111111111',
    api_key_id: 'ak-1',
    api_key_name: 'Proposer',
    rate_limited: false,
    scopes: ['companies:read', 'events:read', 'bookkeeping:write', 'reports:read'],
    mode: 'live',
    unattended_commit_limit: null,
    mcp_only: state.mcpOnly,
  }
}

// A permissive chain: every query resolves to "no rows". Enough for the
// surfaces to get past auth; what happens after auth is not under test.
function emptyChain(): unknown {
  const result = { data: [], error: null, count: 0 }
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve({ data: null, error: null })
      }
      return () => new Proxy({}, handler)
    },
  }
  return new Proxy({}, handler)
}

vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => ({
    rpc: (name: string, args: unknown) => {
      state.rpc(name, args)
      if (name === 'validate_and_increment_api_key') {
        return Promise.resolve({ data: [rpcRow()], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: () => emptyChain(),
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { GET as eventsGET } from '@/app/api/events/route'
import { handleMcpRequest } from '@/extensions/general/mcp-server/server'

const TOKEN = 'gnubok_sk_mcp_only_surface_test'

function restRequest(path: string): Request {
  return new Request(`https://x.test${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

function mcpToolsList(): Request {
  return new Request('https://x.test/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.mcpOnly = true
})

describe('MCP-only key', () => {
  it('is refused by REST /api/v1 with 403 API_KEY_MCP_ONLY and never reaches the handler', async () => {
    const handler = vi.fn(async () => NextResponse.json({ data: [] }))
    const route = withApiV1('companies.list', handler)
    const res = await route(restRequest('/api/v1/companies'), { params: Promise.resolve({}) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('API_KEY_MCP_ONLY')
    expect(body.error.message).toMatch(/MCP/)
    expect(body.error.message_en).toMatch(/MCP-only/)
    expect(handler).not.toHaveBeenCalled()
    expect(state.rpc).toHaveBeenCalledWith('validate_and_increment_api_key', expect.anything())
  })

  it('is refused by /api/events with 403 API_KEY_MCP_ONLY', async () => {
    const res = await eventsGET(restRequest('/api/events'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('API_KEY_MCP_ONLY')
  })

  it('is accepted by the MCP server', async () => {
    const res = await handleMcpRequest(mcpToolsList())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.result?.tools)).toBe(true)
    expect(state.rpc).toHaveBeenCalledWith('validate_and_increment_api_key', expect.anything())
  })
})

describe('ordinary key (mcp_only false)', () => {
  it('still passes REST /api/v1 auth', async () => {
    state.mcpOnly = false
    const handler = vi.fn(async () => NextResponse.json({ data: [] }))
    const route = withApiV1('companies.list', handler)
    const res = await route(restRequest('/api/v1/companies'), { params: Promise.resolve({}) })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('still passes /api/events auth', async () => {
    state.mcpOnly = false
    const res = await eventsGET(restRequest('/api/events'))
    expect([401, 403]).not.toContain(res.status)
  })

  it('still works on the MCP server', async () => {
    state.mcpOnly = false
    const res = await handleMcpRequest(mcpToolsList())
    expect(res.status).toBe(200)
  })
})
