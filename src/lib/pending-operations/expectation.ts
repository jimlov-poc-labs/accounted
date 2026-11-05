/**
 * "What the approver saw" for a pending operation.
 *
 * An approval normally commits whatever the row holds at the moment of the
 * call. A human who approves from a rendered summary (a chat thumbs-up, a
 * widget click) approved the summary, not the row: if the row changed in
 * between, or the wrong id was relayed, the books receive something nobody
 * looked at. An expectation lets the caller pin the facts it showed; the
 * commit is refused, before the atomic claim, when the row no longer matches.
 *
 * All fields are optional and a call without any is unchanged. Once ANY field
 * is present, every present field must be well-formed and must match. A
 * malformed field is a refusal, never ignored: ignoring it would turn a
 * condition the caller believes is enforced into no condition at all.
 */

export const EXPECTATION_MISMATCH = 'EXPECTATION_MISMATCH'
export const EXPECTATION_INVALID = 'EXPECTATION_INVALID'

export interface PendingOperationExpectation {
  /**
   * Amount the operation posts, in the operation's currency (SEK), compared
   * exactly as the preview stores it. Only some types store a signed amount,
   * see AMOUNT_FIELDS: for the others the sign is always positive.
   */
  amount?: number
  operationType?: string
  /** updated_at of the row as the approver saw it. */
  updatedAt?: string
}

export interface ExpectationMismatch {
  field: 'expected_amount' | 'expected_type' | 'expected_updated_at'
  expected: unknown
  actual: unknown
}

export type ParsedExpectation =
  | { ok: true; expectation: PendingOperationExpectation | null }
  | { ok: false; issues: Array<{ field: string; reason: string }> }

/** Raw wire shape, shared by the MCP tool and the REST routes. */
export interface RawExpectation {
  expected_amount?: unknown
  expected_type?: unknown
  expected_updated_at?: unknown
}

/**
 * Preview fields carrying the amount an operation posts, read exactly as
 * stored (the sign is not touched here).
 *
 * SIGNED, the sign is the bank direction (negative = money out), so an
 * income/expense flip IS caught by expected_amount:
 *   categorize_transaction (amount), link_transaction_journal_entry
 *   (transaction_amount).
 * Every other type below stores a debit total, a payment or a sum that is
 * positive by construction (total_debit, total, payment_amount, ...). For
 * those the magnitude is pinned but a flip between income and expense is NOT
 * visible in the amount: the caller must pin expected_type (and, for a
 * voucher, show the lines) instead. Not verified per type against prod data;
 * the unsigned classification follows the field names and the unattended-limit
 * note that they are absolute postings.
 */
const AMOUNT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create_voucher: ['total_debit'],
  categorize_transaction: ['amount'],
  create_supplier_invoice_from_inbox: ['total'],
  link_transaction_journal_entry: ['transaction_amount'],
  bulk_book_transactions: ['tx_sum'],
  link_supplier_invoice_voucher: ['payment_amount'],
  match_batch_allocate: ['total_allocated'],
  mark_invoice_paid: ['total'],
  book_invoice: ['journal_entry.total_debit'],
  bulk_book_invoices: ['total_debit'],
  book_supplier_invoice: ['journal_entry.total_debit'],
  create_supplier_payment_batch: ['total_amount'],
  create_expense_claim: ['amount_sek'],
  record_expense_payout: ['total_sek'],
  match_expense_payout: ['total_sek'],
  redate_entry: ['total_debit'],
  correct_entry_lines_inline: ['changed_amount_sek'],
  book_vat_settlement: ['journal_entry.total_debit'],
  send_invoice_peppol: ['invoice.total'],
  set_opening_balances_manual: ['journal_entry.total_debit'],
  correct_opening_balances: ['journal_entry.total_debit'],
  split_opening_balances_per_project: ['changed_amount_sek'],
}

/** The amount this operation posts, or null when its type carries none. */
export function operationAmount(operationType: string, previewData: unknown): number | null {
  const fields = AMOUNT_FIELDS[operationType]
  if (!fields) return null
  if (previewData === null || typeof previewData !== 'object') return null
  for (const field of fields) {
    let raw: unknown = previewData
    for (const key of field.split('.')) {
      raw = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
    }
    if (raw === null || raw === undefined) continue
    // jsonb numerics can arrive as strings, but only a strict decimal is a
    // number: Number('') is 0, Number(true) is 1, Number([5]) is 5.
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())
          ? Number(raw)
          : Number.NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function hasAny(raw: RawExpectation): boolean {
  return (
    raw.expected_amount !== undefined ||
    raw.expected_type !== undefined ||
    raw.expected_updated_at !== undefined
  )
}

function toMs(value: string): number {
  return Date.parse(value)
}

/**
 * Validate the wire fields. `undefined` means "not supplied"; anything else
 * (null, wrong type, NaN, blank string, unparseable timestamp) is invalid.
 */
export function parseExpectation(raw: RawExpectation): ParsedExpectation {
  if (!hasAny(raw)) return { ok: true, expectation: null }

  const issues: Array<{ field: string; reason: string }> = []
  const expectation: PendingOperationExpectation = {}

  if (raw.expected_amount !== undefined) {
    if (typeof raw.expected_amount === 'number' && Number.isFinite(raw.expected_amount)) {
      expectation.amount = raw.expected_amount
    } else {
      issues.push({ field: 'expected_amount', reason: 'must be a finite number' })
    }
  }
  if (raw.expected_type !== undefined) {
    if (typeof raw.expected_type === 'string' && raw.expected_type.trim() !== '') {
      expectation.operationType = raw.expected_type.trim()
    } else {
      issues.push({ field: 'expected_type', reason: 'must be a non-empty string' })
    }
  }
  if (raw.expected_updated_at !== undefined) {
    if (
      typeof raw.expected_updated_at === 'string' &&
      raw.expected_updated_at.trim() !== '' &&
      Number.isFinite(toMs(raw.expected_updated_at))
    ) {
      expectation.updatedAt = raw.expected_updated_at.trim()
    } else {
      issues.push({ field: 'expected_updated_at', reason: 'must be an ISO 8601 timestamp string' })
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, expectation }
}

function sameTimestamp(a: string, b: string): boolean {
  if (a === b) return true
  const ma = toMs(a)
  const mb = toMs(b)
  return Number.isFinite(ma) && Number.isFinite(mb) && ma === mb
}

/**
 * Compare an expectation with the row as it is NOW. Returns the fields that
 * differ (empty = match). A field the row cannot answer (an amount on a type
 * that posts none, a missing updated_at) counts as a mismatch: unknown never
 * satisfies a condition.
 */
export function checkExpectation(
  expectation: PendingOperationExpectation,
  row: { operation_type: string; preview_data: unknown; updated_at: string | null | undefined },
): ExpectationMismatch[] {
  const mismatches: ExpectationMismatch[] = []

  if (expectation.operationType !== undefined && expectation.operationType !== row.operation_type) {
    mismatches.push({
      field: 'expected_type',
      expected: expectation.operationType,
      actual: row.operation_type,
    })
  }
  if (expectation.amount !== undefined) {
    const actual = operationAmount(row.operation_type, row.preview_data)
    // Compared in öre so 0.1 + 0.2 style float noise cannot cause a false
    // mismatch, while a one-öre difference still does.
    if (actual === null || Math.round(actual * 100) !== Math.round(expectation.amount * 100)) {
      mismatches.push({ field: 'expected_amount', expected: expectation.amount, actual })
    }
  }
  if (expectation.updatedAt !== undefined) {
    const actual = typeof row.updated_at === 'string' ? row.updated_at : null
    if (actual === null || !sameTimestamp(expectation.updatedAt, actual)) {
      mismatches.push({
        field: 'expected_updated_at',
        expected: expectation.updatedAt,
        actual,
      })
    }
  }
  return mismatches
}
