/**
 * "What the approver saw": commitPendingOperation with opts.expected.
 *
 * Where the check sits matters as much as what it checks. It must run BEFORE
 * the atomic claim, so a mismatch leaves the row 'pending' and writes nothing.
 * The tests therefore assert on the recorded builder calls: after a mismatch
 * there is no update() against pending_operations at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { commitPendingOperation } from '../commit'

const UPDATED_AT = '2026-11-05T10:00:00.123456+00:00'

function makeOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'categorize_transaction',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: { amount: -1250 },
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-11-05T09:00:00Z',
    resolved_at: null,
    updated_at: UPDATED_AT,
    ...overrides,
  } as PendingOperation
}

/** The row as the database holds it NOW (what the re-read returns). */
function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    status: 'pending',
    operation_type: 'categorize_transaction',
    preview_data: { amount: -1250 },
    updated_at: UPDATED_AT,
    ...overrides,
  }
}

const hasStatusUpdate = (calls: { table: string; method: string }[]) =>
  calls.some((c) => c.table === 'pending_operations' && c.method === 'update')

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: expected (what the approver saw)', () => {
  it('refuses a different amount before the claim and writes nothing', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ preview_data: { amount: -9999 } }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250 },
    })

    expect(result.status).toBe('failed')
    expect(result.code).toBe('EXPECTATION_MISMATCH')
    expect(result.http_status).toBe(409)
    expect(result.operation_status).toBe('pending')
    // Only the differing field, with both sides, never the whole row.
    expect(result.mismatches).toEqual([{ field: 'expected_amount', expected: -1250, actual: -9999 }])
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('compares against the live row, not the snapshot the caller passed in', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    // Snapshot says -1250 (what the approver saw); the row was edited since.
    enqueue({ data: liveRow({ preview_data: { amount: -80000 } }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250 },
    })

    expect(result.code).toBe('EXPECTATION_MISMATCH')
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('refuses a different operation type', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ operation_type: 'create_voucher' }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { operationType: 'categorize_transaction' },
    })

    expect(result.code).toBe('EXPECTATION_MISMATCH')
    expect(result.mismatches).toEqual([
      { field: 'expected_type', expected: 'categorize_transaction', actual: 'create_voucher' },
    ])
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('refuses when updated_at has moved since the approver looked', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ updated_at: '2026-11-05T10:05:00.000000+00:00' }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { updatedAt: UPDATED_AT },
    })

    expect(result.code).toBe('EXPECTATION_MISMATCH')
    expect(result.mismatches?.map((m) => m.field)).toEqual(['expected_updated_at'])
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('refuses an amount on a type that posts no amount (unknown never satisfies)', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ operation_type: 'create_customer', preview_data: {} }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: 100 },
    })

    expect(result.code).toBe('EXPECTATION_MISMATCH')
    expect(result.mismatches).toEqual([{ field: 'expected_amount', expected: 100, actual: null }])
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('reports every field that differs, and only those', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ preview_data: { amount: -1 } }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250, operationType: 'categorize_transaction', updatedAt: UPDATED_AT },
    })

    expect(result.mismatches?.map((m) => m.field)).toEqual(['expected_amount'])
  })

  it('commits when every expectation matches, and pins the claim to the compared row version', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ operation_type: 'create_customer', preview_data: {} }), error: null }) // re-read
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // company_settings
    enqueue({ data: makeCustomer({ id: 'cust-1' }), error: null }) // customers insert
    enqueue({ data: null, error: null }) // final pending_operations update

    const op = makeOp({
      operation_type: 'create_customer',
      preview_data: {},
      params: { name: 'Kund AB', customer_type: 'swedish_business' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op, {
      expected: { operationType: 'create_customer', updatedAt: UPDATED_AT },
    })

    expect(result.status).toBe('committed')
    // The claim only succeeds on the exact version that was compared.
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['updated_at', UPDATED_AT])
  })

  it('treats a change that lands between the comparison and the claim as lost, not approved', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: liveRow(), error: null }) // re-read matches
    enqueue({ data: null, error: null }) // claim: updated_at moved, 0 rows

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250 },
    })

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('CONFLICT')
  })

  it('a second approval after a successful one is still 409 CONFLICT', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ status: 'committed' }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250 },
    })

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('CONFLICT')
  })

  it('without expected, a second approval is 409 CONFLICT too (unchanged path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // claim finds nothing

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp())

    expect(result.http_status).toBe(409)
    expect(result.code).toBe('CONFLICT')
  })

  it('without expected, no re-read happens and behaviour is unchanged', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // first query is the claim itself
    enqueue({ data: null, error: null })
    enqueue({ data: makeCustomer({ id: 'cust-1' }), error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeOp({ operation_type: 'create_customer', params: { name: 'Kund AB', customer_type: 'swedish_business' } }),
    )

    expect(result.status).toBe('committed')
    const firstPendingOp = calls.find((c) => c.table === 'pending_operations')
    expect(firstPendingOp?.method).toBe('update')
    expect(calls.some((c) => c.method === 'eq' && (c.args as unknown[])[0] === 'updated_at')).toBe(false)
  })

  it('refuses an operation that is not in the approving company (ownership)', async () => {
    const { supabase, enqueue, calls, findCalls } = createQueuedMockSupabase()
    // The re-read is scoped to company_id, so another tenant's row is invisible.
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeOp({ company_id: 'company-2' }),
      { expected: { amount: -1250 } },
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(404)
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('fails closed when the verification read errors', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250 },
    })

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(hasStatusUpdate(calls)).toBe(false)
  })

  it('fails closed when the live row has no updated_at to pin the claim to', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: liveRow({ updated_at: null }), error: null })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makeOp(), {
      expected: { amount: -1250 },
    })

    expect(result.status).toBe('failed')
    expect(hasStatusUpdate(calls)).toBe(false)
  })
})
