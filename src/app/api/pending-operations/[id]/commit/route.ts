import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import {
  EXPECTATION_INVALID,
  EXPECTATION_MISMATCH,
  parseExpectation,
  type RawExpectation,
} from '@/lib/pending-operations/expectation'
import { bookkeepingErrorResponse, AccountsNotInChartError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { PendingOperation } from '@/types'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.commit',
  async (request, { supabase, user, companyId, log }, { params }) => {
    const { id } = await params

    // Optional body pinning what the approver saw (expected_amount,
    // expected_type, expected_updated_at). An empty body is the unchanged
    // legacy call; a body that is present but unreadable or malformed refuses
    // the commit rather than silently dropping the condition.
    let rawExpectation: RawExpectation = {}
    const bodyText = await request.text()
    if (bodyText.trim() !== '') {
      let body: unknown
      try {
        body = JSON.parse(bodyText)
      } catch {
        return NextResponse.json(
          { error: 'Ogiltigt villkor för godkännandet.', code: EXPECTATION_INVALID },
          { status: 400 }
        )
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return NextResponse.json(
          { error: 'Ogiltigt villkor för godkännandet.', code: EXPECTATION_INVALID },
          { status: 400 }
        )
      }
      const b = body as Record<string, unknown>
      rawExpectation = {
        expected_amount: b.expected_amount,
        expected_type: b.expected_type,
        expected_updated_at: b.expected_updated_at,
      }
    }
    const parsedExpectation = parseExpectation(rawExpectation)
    if (!parsedExpectation.ok) {
      return NextResponse.json(
        {
          error: 'Ogiltigt villkor för godkännandet.',
          code: EXPECTATION_INVALID,
          details: { issues: parsedExpectation.issues },
        },
        { status: 400 }
      )
    }

    const { data: op, error: fetchError } = await supabase
      .from('pending_operations')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !op) {
      return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
    }

    try {
      const result = await commitPendingOperation(
        supabase,
        user.id,
        companyId,
        op as PendingOperation,
        {
          userEmail: user.email,
          commitMethod: 'user_accept',
          actor: { type: 'user', ...(user.email ? { label: user.email } : {}) },
          ...(parsedExpectation.expectation ? { expected: parsedExpectation.expectation } : {}),
        }
      )

      if (result.status === 'committed') {
        return NextResponse.json({ data: result.data })
      }
      if (result.code === EXPECTATION_MISMATCH) {
        return NextResponse.json(
          {
            error: getErrorEntry(EXPECTATION_MISMATCH)?.message_sv ?? 'Förslaget har ändrats.',
            code: EXPECTATION_MISMATCH,
            details: { mismatches: result.mismatches ?? [] },
          },
          { status: result.http_status ?? 409 }
        )
      }
      // Recoverable accounts-not-in-chart: return the structured envelope (code +
      // account_numbers) so the client can offer activation and retry the still-
      // pending op, instead of leaking the raw error string into the chat.
      if (result.code === ACCOUNTS_NOT_IN_CHART && result.account_numbers?.length) {
        const structured = bookkeepingErrorResponse(
          new AccountsNotInChartError(result.account_numbers)
        )
        if (structured) return structured
      }
      // The executor's error strings mix Swedish user messages with raw
      // Supabase/Zod English; the pending page toasts this field verbatim, so
      // map it here. Swedish passes through untouched, English falls to the
      // status-appropriate Swedish fallback (issue #337). Raw stays in logs.
      const status = result.http_status ?? 500
      log.warn('pending operation commit failed', {
        operationId: id,
        rawError: result.error,
        status,
      })
      return NextResponse.json(
        { error: getErrorMessage(result.error ?? null, { statusCode: status }) },
        { status }
      )
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      throw err
    }
  },
  { requireWrite: true },
)
