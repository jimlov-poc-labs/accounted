/**
 * documents:upload over MCP: an upload-only key (the n8n receipt drop) can run
 * the two-step upload and nothing else, and keys holding transactions:write
 * (which the upload tools required before) keep uploading.
 *
 * The dispatcher's scope gate is the claim under test. hasCapability is mocked
 * to true and runs right after the scope gate, so "hasCapability was called
 * for this tool" proves the scope gate let the call through, independent of
 * what the stubbed database does inside execute(). A denied call exits before
 * it with errorKind 'scope_denied'.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

const state = vi.hoisted(() => ({
  scopes: [] as string[],
  mcpOnly: true as boolean,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

// validateApiKey is NOT mocked: the service-role client underneath it is, so
// the real key check runs, including the mcp_only refusal for non-MCP
// surfaces (the MCP server is the one caller that asserts surface 'mcp').
vi.mock('@/lib/supabase/service-client', () => {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        return () => chain
      },
    },
  )
  const membershipChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' }, error: null })
        }
        return () => membershipChain
      },
    },
  )
  return {
    createServiceRoleClient: () => ({
      rpc: (name: string) => {
        if (name === 'validate_and_increment_api_key') {
          return Promise.resolve({
            data: [{
              user_id: 'user-1',
              company_id: '11111111-1111-4111-8111-111111111111',
              api_key_id: 'key-1',
              api_key_name: 'n8n kvitton',
              rate_limited: false,
              scopes: state.scopes,
              mode: 'live',
              unattended_commit_limit: null,
              mcp_only: state.mcpOnly,
            }],
            error: null,
          })
        }
        return chain
      },
      from: (table: string) => (table === 'company_members' ? membershipChain : chain),
    }),
  }
})

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn() }
})

import { handleMcpRequest } from '../server'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { TOOL_SCOPE_MAP, effectiveScopes } from '@/lib/auth/api-keys'
import { annotateLoadoutTools } from '../recommended-tools'

const mockHasCapability = vi.mocked(hasCapability)

function mcpRequest(method: string, params?: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gnubok_sk_document_upload_scope_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })
}

interface ToolCalledEvent {
  tool: string
  errorKind: string | null
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ event: ToolCalledEvent; text: string }> {
  const event = new Promise<ToolCalledEvent>((resolve) => {
    const off = eventBus.on('mcp.tool_called', (payload) => {
      off()
      resolve(payload as unknown as ToolCalledEvent)
    })
  })
  const res = await handleMcpRequest(mcpRequest('tools/call', { name, arguments: args }))
  const json = await res.json()
  // A misspelled tool answers with a JSON-RPC error, not a scope denial: fail
  // loudly instead of letting a denial test pass for the wrong reason.
  expect(json.error, `unexpected JSON-RPC error for ${name}`).toBeUndefined()
  return { event: await event, text: json.result.content[0].text as string }
}

const UPLOAD_ID = '22222222-2222-4222-8222-222222222222'

const CREATE_ARGS = { file_name: 'kvitto.pdf' }
const COMPLETE_ARGS = { upload_id: UPLOAD_ID, file_name: 'kvitto.pdf' }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockHasCapability.mockResolvedValue(true)
  state.scopes = ['documents:upload']
  state.mcpOnly = true
})

describe('scope map', () => {
  it('puts the two-step upload on documents:upload and leaves the base64 upload on transactions:write', () => {
    expect(TOOL_SCOPE_MAP.gnubok_create_document_upload).toBe('documents:upload')
    expect(TOOL_SCOPE_MAP.gnubok_complete_document_upload).toBe('documents:upload')
    expect(TOOL_SCOPE_MAP.gnubok_upload_document).toBe('transactions:write')
  })
})

describe('mcp_only key with only documents:upload', () => {
  it.each([
    ['gnubok_create_document_upload', CREATE_ARGS],
    ['gnubok_complete_document_upload', COMPLETE_ARGS],
  ])('may call %s', async (tool, args) => {
    const { event } = await callTool(tool, args)
    expect(event.tool).toBe(tool)
    expect(event.errorKind).not.toBe('scope_denied')
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'ai')
  })

  it.each([
    ['gnubok_create_voucher', 'bookkeeping:write', { description: 'x', entry_date: '2026-09-01', lines: [] }],
    ['gnubok_categorize_transaction', 'transactions:write', { transaction_id: UPLOAD_ID }],
    ['gnubok_link_document_to_voucher', 'bookkeeping:write', { document_id: UPLOAD_ID, journal_entry_id: UPLOAD_ID }],
    ['gnubok_upload_document', 'transactions:write', { file_name: 'kvitto.pdf', file_content_base64: 'AA==' }],
  ])('is refused %s (needs %s)', async (tool, scope, args) => {
    const { event, text } = await callTool(tool, args)
    expect(event.errorKind).toBe('scope_denied')
    const error = (JSON.parse(text) as { error: { code: string; message_en: string } }).error
    expect(error.code).toBe('INSUFFICIENT_SCOPE')
    expect(error.message_en).toContain(`"${scope}"`)
    expect(mockHasCapability).not.toHaveBeenCalled()
  })

  it('lists the two upload tools and none of the booking tools', async () => {
    const res = await handleMcpRequest(mcpRequest('tools/list'))
    const names = ((await res.json()).result.tools as { name: string }[]).map((t) => t.name)
    const uploadTools = names.filter((n) => /create_document_upload|complete_document_upload/.test(n))
    expect(uploadTools).toHaveLength(2)
    expect(names.some((n) => /create_voucher|categorize_transaction|link_document_to_voucher/.test(n))).toBe(false)
  })
})

describe('key with transactions:write (no documents:upload)', () => {
  it.each([
    ['gnubok_create_document_upload', CREATE_ARGS],
    ['gnubok_complete_document_upload', COMPLETE_ARGS],
  ])('keeps calling %s through the implied documents:upload', async (tool, args) => {
    state.scopes = ['transactions:read', 'transactions:write']
    state.mcpOnly = false
    const { event } = await callTool(tool, args)
    expect(event.errorKind).not.toBe('scope_denied')
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'ai')
  })

  it('finds the upload tools through search_tools', async () => {
    state.scopes = ['transactions:read', 'transactions:write']
    state.mcpOnly = false
    const { text } = await callTool('gnubok_search_tools', { query: 'document upload', detail: 'name' })
    expect(text).toMatch(/create_document_upload/)
    expect(text).toMatch(/complete_document_upload/)
  })
})

describe('briefing loadouts', () => {
  it('report the upload tools as callable for a transactions:write key (scopes expanded with implications)', () => {
    const entries = annotateLoadoutTools(
      ['gnubok_create_document_upload', 'gnubok_complete_document_upload'],
      (name) => ({ required_scope: TOOL_SCOPE_MAP[name] ?? null, callable_via: 'tools_list' }),
      effectiveScopes(['transactions:write']),
    )
    for (const entry of entries) expect(entry.callable, entry.name).toBe(true)
  })
})
