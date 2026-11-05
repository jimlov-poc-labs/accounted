/**
 * gnubok_approve_pending_operation with expected_* (what the approver saw),
 * through the REAL commitPendingOperation so the whole path is exercised:
 * validation -> fetch -> live re-read -> compare -> (claim).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const historySpy = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...a: unknown[]) => historySpy(...a),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { tools } from '../server'

const approveTool = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!

const UPDATED_AT = '2026-11-05T10:00:00.123456+00:00'
const OP_ID = '9a44c1de-0000-4000-8000-000000000001'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: OP_ID,
  company_id: 'company-1',
  user_id: 'user-1',
  operation_type: 'categorize_transaction',
  status: 'pending',
  risk_level: 'low',
  title: 't',
  params: {},
  preview_data: { amount: -1250 },
  updated_at: UPDATED_AT,
  ...overrides,
})

const run = (args: Record<string, unknown>, supabase: unknown) =>
  approveTool.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' }) as Promise<
    Record<string, unknown>
  >

const touchedClaim = (calls: { table: string; method: string }[]) =>
  calls.some((c) => c.table === 'pending_operations' && c.method === 'update')

beforeEach(() => vi.clearAllMocks())

describe('gnubok_approve_pending_operation: expected_*', () => {
  it('declares the optional expected_* parameters', () => {
    const props = (approveTool.inputSchema as { properties: Record<string, unknown> }).properties
    for (const k of ['expected_amount', 'expected_type', 'expected_updated_at', 'expected_operations']) {
      expect(props).toHaveProperty(k)
    }
    expect((approveTool.inputSchema as { required: string[] }).required).toEqual([])
  })

  it('refuses a different amount with EXPECTATION_MISMATCH, naming only the differing field, and does not claim', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null }) // tool fetch
    enqueue({ data: row({ preview_data: { amount: -99999 } }), error: null }) // live re-read

    const result = await run({ operation_id: OP_ID, expected_amount: -1250 }, supabase)

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('EXPECTATION_MISMATCH')
    expect(result.operation_status).toBe('pending')
    expect(result.mismatches).toEqual([{ field: 'expected_amount', expected: -1250, actual: -99999 }])
    expect(touchedClaim(calls)).toBe(false)
  })

  it('refuses a different type', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: row({ operation_type: 'create_voucher' }), error: null })

    const result = await run({ operation_id: OP_ID, expected_type: 'categorize_transaction' }, supabase)

    expect(result.error_code).toBe('EXPECTATION_MISMATCH')
    expect(touchedClaim(calls)).toBe(false)
  })

  it('refuses a changed updated_at', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: row({ updated_at: '2026-11-05T11:00:00.000000+00:00' }), error: null })

    const result = await run({ operation_id: OP_ID, expected_updated_at: UPDATED_AT }, supabase)

    expect(result.error_code).toBe('EXPECTATION_MISMATCH')
    expect(touchedClaim(calls)).toBe(false)
  })

  it.each([
    ['NaN amount', { expected_amount: Number.NaN }],
    ['string amount', { expected_amount: '1250' }],
    ['null amount', { expected_amount: null }],
    ['empty type', { expected_type: '' }],
    ['empty updated_at', { expected_updated_at: '' }],
    ['garbage updated_at', { expected_updated_at: 'nope' }],
  ])('refuses a malformed condition before touching the database: %s', async (_l, extra) => {
    const { supabase, calls } = createQueuedMockSupabase()

    await expect(run({ operation_id: OP_ID, ...extra }, supabase)).rejects.toMatchObject({
      code: 'EXPECTATION_INVALID',
    })
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['expected_amout', { expected_amout: 1 }],
    ['expecteds', { expecteds: { amount: 1 } }],
    ['expectedAmount', { expectedAmount: 1 }],
    ['EXPECTED_TYPE', { EXPECTED_TYPE: 'x' }],
  ])('refuses a misspelled expectation key instead of approving unconditionally: %s', async (_l, extra) => {
    const { supabase, calls } = createQueuedMockSupabase()

    await expect(run({ operation_id: OP_ID, ...extra }, supabase)).rejects.toMatchObject({
      code: 'EXPECTATION_INVALID',
    })
    expect(calls).toHaveLength(0)
  })

  it('refuses a misspelled key inside an expected_operations entry', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    await expect(
      run({ batch_id: '8c1f0000-0000-4000-8000-000000000001', expected_operations: [{ operation_id: OP_ID, expected_amout: 1 }] }, supabase),
    ).rejects.toMatchObject({ code: 'EXPECTATION_INVALID' })
    expect(calls).toHaveLength(0)
  })

  it('refuses an unknown key next to valid ones inside an expected_operations entry', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    await expect(
      run({ batch_id: '8c1f0000-0000-4000-8000-000000000001', expected_operations: [{ operation_id: OP_ID, expected_amount: 1, expected_ammount: 2 }] }, supabase),
    ).rejects.toMatchObject({ code: 'EXPECTATION_INVALID' })
    expect(calls).toHaveLength(0)
  })

  it('does not trip on the harness-injected __ keys', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: null, error: null })
    const result = await run({ operation_id: OP_ID, __keyScopes: ['pending_operations:approve'] }, supabase)
    expect(result.error_code).toBe('CONFLICT')
  })

  it('audits that an approval was conditional, and that a mismatch was refused (field names only)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: row({ preview_data: { amount: -1 } }), error: null })

    await run({ operation_id: OP_ID, expected_amount: -1250, expected_type: 'categorize_transaction' }, supabase)

    const payload = historySpy.mock.calls[0][0].payload
    expect(payload.conditional).toBe(true)
    expect(payload.expected_fields).toEqual(['expected_amount', 'expected_type'])
    expect(payload.mismatch_fields).toEqual(['expected_amount'])
    expect(JSON.stringify(payload)).not.toContain('-1250')
  })

  it('an unconditional approval is audited as not conditional', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: null, error: null })
    await run({ operation_id: OP_ID }, supabase)
    expect(historySpy.mock.calls[0][0].payload.conditional).toBe(false)
  })

  it('describes every expected_* field and that omitting them means unconditional', () => {
    const props = (approveTool.inputSchema as { properties: Record<string, { description?: string }> }).properties
    for (const k of ['expected_amount', 'expected_type', 'expected_updated_at']) {
      expect(props[k].description).toBeTruthy()
    }
    expect(approveTool.description).toMatch(/explicitly authorised/)
    expect(JSON.stringify(approveTool.inputSchema)).toMatch(/omit/i)
  })

  it('matching expectations pass the check and proceed to the atomic claim', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: row(), error: null }) // re-read matches
    enqueue({ data: null, error: null }) // claim: nothing (proves we reached it)

    const result = await run(
      { operation_id: OP_ID, expected_amount: -1250, expected_type: 'categorize_transaction', expected_updated_at: UPDATED_AT },
      supabase,
    )

    expect(result.error_code).toBe('CONFLICT') // reached the claim, not an expectation error
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['updated_at', UPDATED_AT])
  })

  it('without expected_* behaves as before: no re-read, straight to the claim', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: row(), error: null })
    enqueue({ data: null, error: null }) // claim: nothing

    const result = await run({ operation_id: OP_ID }, supabase)

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('CONFLICT')
    // Only the tool's own fetch ('*') reads the row; the verification
    // re-read (a column list with preview_data) must not happen.
    const reads = calls.filter((c) => c.table === 'pending_operations' && c.method === 'select')
    expect(reads.some((c) => String((c as { args?: unknown[] }).args?.[0]).includes('preview_data'))).toBe(false)
  })

  it('second approval after a committed one is still CONFLICT, with or without expectations', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row({ status: 'committed' }), error: null })
    enqueue({ data: row({ status: 'committed' }), error: null })

    const result = await run({ operation_id: OP_ID, expected_amount: -1250 }, supabase)

    expect(result.status).toBe('failed')
    expect(result.error_code).toBe('CONFLICT')
  })

  it("refuses another company's operation (tool fetch is scoped to the key's company)", async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } }) // not visible in company-1

    await expect(run({ operation_id: OP_ID, expected_amount: -1250 }, supabase)).rejects.toBeDefined()
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(touchedClaim(calls)).toBe(false)
  })

  describe('batch', () => {
    const OP2 = '9a44c1de-0000-4000-8000-000000000002'
    const BATCH = '8c1f0000-0000-4000-8000-000000000001'

    it('rejects scalar expected_* together with batch_id', async () => {
      const { supabase, calls } = createQueuedMockSupabase()
      await expect(run({ batch_id: BATCH, expected_amount: 1 }, supabase)).rejects.toMatchObject({
        code: 'EXPECTATION_INVALID',
      })
      expect(calls).toHaveLength(0)
    })

    it('rejects expected_operations without batch_id and malformed entries', async () => {
      const { supabase } = createQueuedMockSupabase()
      await expect(
        run({ operation_id: OP_ID, expected_operations: [{ operation_id: OP_ID, expected_amount: 1 }] }, supabase),
      ).rejects.toMatchObject({ code: 'EXPECTATION_INVALID' })
      for (const bad of [[], [{ operation_id: OP_ID }], [{ operation_id: OP_ID, expected_amount: Number.NaN }], 'x']) {
        await expect(run({ batch_id: BATCH, expected_operations: bad }, supabase)).rejects.toMatchObject({
          code: 'EXPECTATION_INVALID',
        })
      }
    })

    it('rejects an entry for an operation outside the batch', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [row()], error: null })
      await expect(
        run({ batch_id: BATCH, expected_operations: [{ operation_id: OP2, expected_amount: 1 }] }, supabase),
      ).rejects.toMatchObject({ code: 'EXPECTATION_INVALID' })
    })
  })
})
