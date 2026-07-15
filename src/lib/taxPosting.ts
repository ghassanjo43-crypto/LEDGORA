import type { TaxSnapshot } from '@/types/taxCode';
import { roundTo } from '@/lib/taxRounding';

/**
 * Centralized tax-line posting. Given a frozen {@link TaxSnapshot} and the
 * transaction direction, produce ONLY the tax-specific journal-line
 * contributions (the net revenue/expense and party control lines belong to the
 * document). Returned lines carry `taxCode`/`taxAmount` metadata so the tax
 * reports and GL reconciliation can find them.
 */
export interface TaxPostingLine {
  accountId: string;
  debit: number;
  credit: number;
  memo: string;
  taxCode: string;
  taxAmount: number;
  kind: 'output' | 'input-recoverable' | 'input-non-recoverable' | 'reverse-charge-output' | 'withholding';
}

export interface TaxPostingContext {
  direction: 'sales' | 'purchase';
  /** Account the non-recoverable input tax is absorbed into (expense/asset). */
  nonRecoverableTargetAccountId?: string;
  reference?: string;
}

/**
 * Build the tax journal lines implied by a snapshot:
 *  - Sales taxable → Cr output tax.
 *  - Purchase taxable → Dr input tax (recoverable) [+ non-recoverable to target].
 *  - Reverse charge → Dr input tax (recoverable) AND Cr output tax.
 *  - Zero-rated / exempt / out-of-scope / withholding → no tax line here.
 */
export function buildTaxPostingLines(snapshot: TaxSnapshot, ctx: TaxPostingContext): TaxPostingLine[] {
  const lines: TaxPostingLine[] = [];
  const ref = ctx.reference ? ` — ${ctx.reference}` : '';
  const tax = roundTo(snapshot.taxAmount, snapshot.precision);
  if (tax <= 0) return lines; // zero-rated / exempt / out-of-scope: reportable base but no tax line

  const recoverable = roundTo(snapshot.recoverableTaxAmount ?? tax, snapshot.precision);
  const nonRecoverable = roundTo(snapshot.nonRecoverableTaxAmount ?? 0, snapshot.precision);

  if (snapshot.category === 'reverse-charge') {
    const inAcc = snapshot.reverseChargeInputAccountId ?? snapshot.inputTaxAccountId;
    const outAcc = snapshot.reverseChargeOutputAccountId ?? snapshot.outputTaxAccountId;
    if (recoverable > 0 && inAcc) lines.push({ accountId: inAcc, debit: recoverable, credit: 0, memo: `Reverse-charge input tax${ref}`, taxCode: snapshot.taxCode, taxAmount: recoverable, kind: 'input-recoverable' });
    if (nonRecoverable > 0 && ctx.nonRecoverableTargetAccountId) lines.push({ accountId: ctx.nonRecoverableTargetAccountId, debit: nonRecoverable, credit: 0, memo: `Non-recoverable reverse-charge tax${ref}`, taxCode: snapshot.taxCode, taxAmount: nonRecoverable, kind: 'input-non-recoverable' });
    if (outAcc) lines.push({ accountId: outAcc, debit: 0, credit: tax, memo: `Reverse-charge output tax${ref}`, taxCode: snapshot.taxCode, taxAmount: tax, kind: 'reverse-charge-output' });
    return lines;
  }

  if (ctx.direction === 'sales') {
    const outAcc = snapshot.outputTaxAccountId ?? snapshot.taxPayableAccountId;
    if (outAcc) lines.push({ accountId: outAcc, debit: 0, credit: tax, memo: `Output tax${ref}`, taxCode: snapshot.taxCode, taxAmount: tax, kind: 'output' });
    return lines;
  }

  // purchase
  const inAcc = snapshot.inputTaxAccountId ?? snapshot.taxReceivableAccountId;
  if (recoverable > 0 && inAcc) lines.push({ accountId: inAcc, debit: recoverable, credit: 0, memo: `Input tax recoverable${ref}`, taxCode: snapshot.taxCode, taxAmount: recoverable, kind: 'input-recoverable' });
  if (nonRecoverable > 0 && ctx.nonRecoverableTargetAccountId) lines.push({ accountId: ctx.nonRecoverableTargetAccountId, debit: nonRecoverable, credit: 0, memo: `Non-recoverable input tax${ref}`, taxCode: snapshot.taxCode, taxAmount: nonRecoverable, kind: 'input-non-recoverable' });
  return lines;
}
