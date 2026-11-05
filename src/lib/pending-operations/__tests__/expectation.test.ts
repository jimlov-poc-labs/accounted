import { describe, it, expect } from 'vitest'
import { checkExpectation, operationAmount, parseExpectation } from '../expectation'

describe('parseExpectation', () => {
  it('absent fields mean no expectation', () => {
    expect(parseExpectation({})).toEqual({ ok: true, expectation: null })
  })

  it('accepts well-formed fields', () => {
    expect(
      parseExpectation({
        expected_amount: -1250.5,
        expected_type: ' create_voucher ',
        expected_updated_at: '2026-11-05T10:00:00Z',
      }),
    ).toEqual({
      ok: true,
      expectation: { amount: -1250.5, operationType: 'create_voucher', updatedAt: '2026-11-05T10:00:00Z' },
    })
  })

  it.each([
    ['NaN', { expected_amount: Number.NaN }],
    ['Infinity', { expected_amount: Infinity }],
    ['string amount', { expected_amount: '100' }],
    ['null amount', { expected_amount: null }],
    ['object amount', { expected_amount: {} }],
    ['empty type', { expected_type: '' }],
    ['blank type', { expected_type: '   ' }],
    ['numeric type', { expected_type: 5 }],
    ['null type', { expected_type: null }],
    ['empty timestamp', { expected_updated_at: '' }],
    ['garbage timestamp', { expected_updated_at: 'yesterday' }],
    ['numeric timestamp', { expected_updated_at: 1762336800000 }],
    ['null timestamp', { expected_updated_at: null }],
  ])('refuses a malformed field instead of ignoring it: %s', (_label, raw) => {
    expect(parseExpectation(raw).ok).toBe(false)
  })

  it('one bad field refuses the lot even when another is fine', () => {
    const parsed = parseExpectation({ expected_type: 'create_voucher', expected_amount: Number.NaN })
    expect(parsed.ok).toBe(false)
  })
})

describe('operationAmount', () => {
  it('keeps the sign and reads nested fields', () => {
    expect(operationAmount('categorize_transaction', { amount: -50 })).toBe(-50)
    expect(operationAmount('book_invoice', { journal_entry: { total_debit: '12.5' } })).toBe(12.5)
  })
  it('is null for types that post nothing or for broken previews', () => {
    expect(operationAmount('create_customer', { amount: 1 })).toBeNull()
    expect(operationAmount('categorize_transaction', null)).toBeNull()
    expect(operationAmount('categorize_transaction', { amount: 'abc' })).toBeNull()
  })
})

describe('checkExpectation', () => {
  const row = { operation_type: 'categorize_transaction', preview_data: { amount: 0.3 }, updated_at: '2026-11-05T10:00:00.123456+00:00' }

  it('matches in öre, immune to float noise', () => {
    expect(checkExpectation({ amount: 0.1 + 0.2 }, row)).toEqual([])
  })
  it('a one-öre difference is a mismatch', () => {
    expect(checkExpectation({ amount: 0.31 }, row)).toHaveLength(1)
  })
  it('a sign flip is a mismatch', () => {
    expect(checkExpectation({ amount: -0.3 }, row)).toHaveLength(1)
  })
  it('timestamps match across formats of the same instant', () => {
    expect(checkExpectation({ updatedAt: '2026-11-05T10:00:00.123Z' }, { ...row, updated_at: '2026-11-05T10:00:00.123+00:00' })).toEqual([])
  })
  it('a missing live updated_at never satisfies an updated_at condition', () => {
    expect(checkExpectation({ updatedAt: '2026-11-05T10:00:00Z' }, { ...row, updated_at: null })).toHaveLength(1)
  })
})
