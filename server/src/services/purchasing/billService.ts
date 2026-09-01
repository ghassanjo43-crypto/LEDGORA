/**
 * Supplier bills: what the business owes, computed and posted by the server.
 *
 * ══ The P2 boundary, and why each refusal is here ════════════════════════════
 *
 * A supported bill is functional-currency, tax-free, and made of service,
 * expense or non-inventory asset lines. Everything else the browser bill can
 * carry — purchase tax, withholding, additional charges, stock, projects, cost
 * centres, purchase orders, goods receipts, templates, attachments, payments —
 * is REFUSED BY NAME rather than dropped.
 *
 * Dropping is the tempting failure: the request succeeds, the user believes the
 * bill carries 16% input tax and a cost centre, the books carry neither, and
 * nothing anywhere says so. A refusal is recoverable; a silently different
 * document is discovered at an audit. S2b established that rule for sales and
 * it holds identically here.
 *
 * ══ Purchase tax is NOT sales tax pointed the other way ══════════════════════
 *
 * S2c made output tax server-authoritative. None of it is reused here. Output
 * tax is a LIABILITY the business collects for an authority; input tax is a
 * RECEIVABLE it may or may not recover, subject to recoverability rules,
 * partial exemption and a different set of accounts. Treating one as the other
 * because both are "tax" would post a recoverable asset into a liability
 * account. Purchase tax is P3, and until then a tax-bearing bill is refused.
 *
 * ══ The accounting, once ═════════════════════════════════════════════════════
 *
 *     Dr  each line's NET amount   → the line's own expense/asset account
 *         Cr  the supplier's payable                        the bill total
 *
 * The payable comes from the SUPPLIER's P1 profile, never from the request —
 * a caller naming its own payable is choosing where a purchase lands, which is
 * the server's decision and settlement's to rely on later.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database, SupplierBillStatus } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { loadAccountsForPosting, type AccountRecord } from '../accounting/accountService.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import { toCalendarDate, toCalendarDateOrNull } from '../accounting/calendarDate.js';
import * as Money from '../accounting/money.js';
import { postSourceJournalIn } from '../accounting/sourcePostingService.js';
import { reverseJournalIn } from '../accounting/journalService.js';
import { assertNoLiveAllocations } from './paymentService.js';
import * as SalesTax from '../accounting/salesTax.js';
import {
  resolveTaxForDate, assertInputAccountPostable, PARTIAL_RECOVERY_UNSUPPORTED,
  type ResolvedTax,
} from '../invoicing/taxCodeService.js';

type Trx = Transaction<Database>;
type Executor = Kysely<Database> | Trx;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What `source_type` a bill's ledger entry carries. Already in SOURCE_TYPES. */
export const BILL_SOURCE_TYPE = 'bill';
/**
 * What happened to the document. The unique index from migration 029 is PARTIAL
 * on this, so a posting without one is covered by nothing — which is exactly
 * how the sales path once let a retry write a second journal.
 */
export const BILL_POST_EVENT = 'post';
export const BILL_REVERSE_EVENT = 'reverse';

/** Statuses a draft edit is still allowed in. */
const EDITABLE: readonly SupplierBillStatus[] = ['draft'];

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

/**
 * Figures a client may SEND but never decides.
 *
 * P2 refused purchase tax outright because the server could not compute it. P3
 * can — from a code these books own, facing purchases, at a rate effective on
 * the bill's own posting date — so the refusal MOVES rather than disappearing:
 * what is refused is the client telling the server what the answer is.
 *
 * A rate, an amount, a base, a category, a method, a recoverability, an
 * applicability, a rate-version id, an account or a snapshot arriving in the
 * request is not a hint to validate. It is an attempt to author the figure a
 * tax authority will be shown. Only `taxCodeId` is accepted.
 */
const CLIENT_OWNED_TAX_FIELDS: Record<string, string> = {
  taxRate: 'a rate',
  taxAmount: 'an amount',
  taxableAmount: 'a taxable base',
  taxCategory: 'a category',
  taxCalculationMethod: 'a calculation method',
  taxDirection: 'an applicability',
  taxRecoverability: 'a recoverability',
  recoverableTaxAmount: 'a recoverable amount',
  nonRecoverableTaxAmount: 'a non-recoverable amount',
  taxRateVersionId: 'a rate version',
  taxAccountId: 'an account',
  taxSnapshot: 'a snapshot',
  taxInclusive: 'a tax-inclusive marker',
  reverseCharge: 'a reverse-charge marker',
};

const UNSUPPORTED_WITHHOLDING =
  'This bill withholds tax. Withholding is recognised at a payment or a posting stage with its own '
  + 'liability account, and none of that is configured on the server. Nothing has been saved.';

const UNSUPPORTED_CHARGES =
  'Additional charges are not supported on server-held bills: there is no controlled account for '
  + 'them, so the entry could not say where they post. Nothing has been saved.';

const UNSUPPORTED_INVENTORY =
  'This bill receives stock. Inventory movements and stock valuation are not on the server, so '
  + 'posting here would record the cost without ever increasing stock. Nothing has been saved.';

/** One message per browser-resident dimension, naming the field. */
const UNVERIFIABLE: Record<string, string> = {
  projectId: 'projects',
  costCenterId: 'cost centres',
  purchaseOrderId: 'purchase orders',
  goodsReceiptId: 'goods receipts',
  templateId: 'bill templates',
  attachments: 'attachments',
};

function refuseUnverifiable(field: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value) && value.length === 0) return;
  const what = UNVERIFIABLE[field] ?? field;
  throw errors.validation(
    `This bill references ${what}, which the server cannot verify or account for yet. A durable `
    + 'bill may not name a record the books cannot check, and it must not imply a workflow that '
    + 'does not exist. Nothing has been saved.',
    { fieldErrors: { [field]: `Remove the ${what} reference to save this bill.` } },
  );
}

/**
 * Tax figures a client may SEND but never decides — and here, may not send at all.
 *
 * Unlike sales, there is no supported value: P2 has no purchase-tax model, so
 * even a zero is refused. A "0" from a client that believed the purchase was
 * exempt is exactly the mistake a server-resolved treatment would prevent, and
 * accepting it would quietly convert a taxable purchase into a tax-free one.
 */
const WITHHOLDING_FIELDS = ['withholdingTaxRate', 'withholdingTaxAmount'];

/* ══ Input shapes ══════════════════════════════════════════════════════════ */

export interface BillLineInput {
  description?: string;
  accountId: string;
  /** The tax CODE, and nothing else about the tax. */
  taxCodeId?: string | null;
  /** Decimal STRINGS throughout. See `money.ts` for why these are never numbers. */
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: string | null;
}

export interface BillInput {
  issuingEntityId?: string;
  supplierId?: string;
  supplierInvoiceNumber?: string;
  billDate?: string;
  postingDate?: string;
  dueDate?: string;
  memo?: string;
  /** Refused when present and different from the functional currency. */
  currency?: string;
  lines?: BillLineInput[];
  /* Everything below is refused. Typed so it can be refused EXPLICITLY rather
   * than arriving, being read by nothing, and vanishing in silence. */
  additionalChargesTotal?: string;
  projectId?: string | null;
  costCenterId?: string | null;
  purchaseOrderId?: string | null;
  goodsReceiptId?: string | null;
  templateId?: string | null;
  attachments?: unknown[];
  status?: string;
  billNumber?: string;
  subtotal?: string;
  total?: string;
}

export interface MutationOptions {
  expectedVersion?: number;
}

/* ══ Records ═══════════════════════════════════════════════════════════════ */

export interface BillLineRecord {
  id: string;
  lineNumber: number;
  description: string;
  accountId: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string | null;
  discountAmount: string;
  /** quantity x unitPrice, before discount. */
  lineSubtotal: string;
  /** The discounted line amount, tax-bearing, before any split. */
  lineNet: string;
  /** What the line's own account was debited, net of tax. */
  taxableAmount: string;
  taxAmount: string;
  /** taxable + tax — what the supplier is owed for this line. */
  grossAmount: string;
  taxCodeId: string | null;
  /**
   * The FROZEN snapshot, present only once the bill is posted WITH a tax code.
   *
   * Null on a draft, and null on a bill posted before purchase tax existed —
   * `capturedAt` is how a deliberate zero-tax posting is told from neither.
   */
  taxSnapshot: BillLineTaxSnapshot | null;
}

/** Everything needed to reproduce and audit one line's purchase tax. */
export interface BillLineTaxSnapshot {
  taxCodeId: string;
  code: string;
  name: string;
  direction: string;
  category: string;
  calculationMethod: string;
  /** Always `recoverable`; partial recovery is refused. */
  recoverability: string;
  rate: string;
  rateVersionId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** The date the rate was resolved on — this bill's posting date. */
  taxPointDate: string | null;
  taxableAmount: string;
  taxAmount: string;
  recoverableTaxAmount: string;
  grossAmount: string;
  inputTaxAccountId: string | null;
  capturedAt: string | null;
}

export interface BillRecord {
  id: string;
  billNumber: string;
  supplierInvoiceNumber: string;
  status: SupplierBillStatus;
  issuingEntityId: string;
  supplierId: string;
  billDate: string;
  postingDate: string;
  dueDate: string;
  currency: string;
  memo: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  payableAccountId: string | null;
  inputTaxAccountId: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
  lines: BillLineRecord[];
}

const display = (value: unknown, decimals: number): string =>
  Money.toDecimalString(Money.roundTo(Money.toAmount(String(value ?? '0')), decimals)).slice(
    0,
    decimals > 0 ? -(Money.SCALE - decimals) : undefined,
  );

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toLine(row: any, decimals: number): BillLineRecord {
  return {
    id: row.id,
    lineNumber: row.line_number,
    description: row.description,
    accountId: row.account_id,
    quantity: display(row.quantity, 6),
    unit: row.unit,
    unitPrice: display(row.unit_price, decimals),
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : display(row.discount_value, decimals),
    discountAmount: display(row.discount_amount, decimals),
    lineSubtotal: display(row.line_subtotal, decimals),
    lineNet: display(row.line_net, decimals),
    taxableAmount: display(row.taxable_amount ?? row.line_net, decimals),
    taxAmount: display(row.tax_amount ?? '0', decimals),
    grossAmount: display(row.gross_amount ?? row.line_net, decimals),
    taxCodeId: row.tax_code_id ?? null,
    taxSnapshot: row.tax_snapshot_at && row.tax_code_id ? {
      taxCodeId: row.tax_code_id,
      code: row.tax_code_code ?? '',
      name: row.tax_code_name ?? '',
      direction: row.tax_direction ?? '',
      category: row.tax_category ?? '',
      calculationMethod: row.tax_calculation_method ?? '',
      recoverability: row.tax_recoverability ?? '',
      rate: display(row.tax_rate ?? '0', decimals),
      rateVersionId: row.tax_rate_version_id ?? null,
      effectiveFrom: toCalendarDateOrNull(row.tax_rate_effective_from),
      effectiveTo: toCalendarDateOrNull(row.tax_rate_effective_to),
      taxPointDate: toCalendarDateOrNull(row.tax_point_date),
      taxableAmount: display(row.taxable_amount ?? '0', decimals),
      taxAmount: display(row.tax_amount ?? '0', decimals),
      recoverableTaxAmount: display(row.recoverable_tax_amount ?? '0', decimals),
      grossAmount: display(row.gross_amount ?? '0', decimals),
      inputTaxAccountId: row.tax_account_id ?? null,
      capturedAt: iso(row.tax_snapshot_at),
    } : null,
  };
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toBill(row: any, lines: any[]): BillRecord {
  const decimals = monetaryDecimalsFor(row.currency);
  return {
    id: row.id,
    billNumber: row.bill_number,
    supplierInvoiceNumber: row.supplier_invoice_number,
    status: row.status,
    issuingEntityId: row.issuing_entity_id,
    supplierId: row.supplier_id,
    billDate: toCalendarDate(row.bill_date),
    postingDate: toCalendarDate(row.posting_date),
    dueDate: toCalendarDate(row.due_date),
    currency: row.currency,
    memo: row.memo,
    subtotal: display(row.subtotal, decimals),
    discountTotal: display(row.discount_total, decimals),
    taxTotal: display(row.tax_total ?? '0', decimals),
    total: display(row.total, decimals),
    payableAccountId: row.payable_account_id,
    inputTaxAccountId: row.input_tax_account_id ?? null,
    journalEntryId: row.journal_entry_id,
    reversalJournalEntryId: row.reversal_journal_entry_id,
    reversalReason: row.reversal_reason,
    postedAt: iso(row.posted_at),
    reversedAt: iso(row.reversed_at),
    version: Number(row.version),
    lines: lines.map((line) => toLine(line, decimals)),
  };
}

/* ══ The boundary ══════════════════════════════════════════════════════════ */

function assertWithinBoundary(input: BillInput): void {
  for (const [index, line] of (input.lines ?? []).entries()) {
    const at = index + 1;
    const raw = line as unknown as Record<string, unknown>;

    for (const [field, what] of Object.entries(CLIENT_OWNED_TAX_FIELDS)) {
      const value = raw[field];
      if (value === undefined || value === null || value === '') continue;
      /*
       * A ZERO is refused with everything else. "0" from a client that believed
       * the purchase was exempt is exactly the mistake a server-resolved
       * category exists to prevent, and accepting it would quietly convert a
       * taxable purchase into a tax-free one.
       */
      throw errors.validation(
        `This bill supplies ${what} for its tax on line ${at}. Purchase tax is calculated by the `
        + 'server from the tax code and the bill date, so a figure sent with the request would be '
        + 'the client deciding what a tax authority is shown. Send the tax code alone. '
        + 'Nothing has been saved.',
        { fieldErrors: { [`lines.${at}.${field}`]: 'Remove this — the server derives it from the tax code.' } },
      );
    }
    for (const field of WITHHOLDING_FIELDS) {
      const value = raw[field];
      if (value === undefined || value === null || value === '') continue;
      throw errors.validation(UNSUPPORTED_WITHHOLDING, {
        fieldErrors: { [`lines.${at}.${field}`]: 'Remove the withholding from this line.' },
      });
    }
    /*
     * Partial recoverability is refused by NAME, not folded into the list
     * above, because it is the one field the specification asks for and cannot
     * describe consistently.
     */
    if (raw.recoverabilityPercent !== undefined && raw.recoverabilityPercent !== null) {
      throw errors.validation(PARTIAL_RECOVERY_UNSUPPORTED, {
        fieldErrors: { [`lines.${at}.recoverabilityPercent`]: 'Remove it — input tax here is fully recoverable.' },
      });
    }

    /*
     * Stock is refused by the SHAPE of the line, not by a flag the client sets.
     * A line naming an item or a warehouse moves stock; that is a property of
     * what was sent rather than a claim about it, which is what stops a caller
     * marking a stocked line "not stock" to slip past the subledger.
     */
    for (const field of ['itemId', 'inventoryItemId', 'warehouseId', 'inventoryReceiptMode', 'capitalAssetId']) {
      if (raw[field]) {
        throw errors.validation(UNSUPPORTED_INVENTORY, {
          fieldErrors: { [`lines.${at}.${field}`]: 'Remove the stock reference, or record it from a demo workspace.' },
        });
      }
    }

    refuseUnverifiable('projectId', raw.projectId);
    refuseUnverifiable('costCenterId', raw.costCenterId);
    if (Array.isArray(raw.costCenterAssignments) && raw.costCenterAssignments.length > 0) {
      refuseUnverifiable('costCenterId', 'assigned');
    }
  }

  /* ── Document level ──────────────────────────────────────────────────── */

  if (input.additionalChargesTotal !== undefined
      && input.additionalChargesTotal !== ''
      && /[1-9]/.test(input.additionalChargesTotal)) {
    throw errors.validation(UNSUPPORTED_CHARGES, {
      fieldErrors: { additionalChargesTotal: 'Remove the additional charges to save this bill.' },
    });
  }

  refuseUnverifiable('projectId', input.projectId);
  refuseUnverifiable('costCenterId', input.costCenterId);
  refuseUnverifiable('purchaseOrderId', input.purchaseOrderId);
  refuseUnverifiable('goodsReceiptId', input.goodsReceiptId);
  refuseUnverifiable('templateId', input.templateId);
  refuseUnverifiable('attachments', input.attachments);

  /* ── Decided by the server, never by the caller ──────────────────────── */

  if (input.status !== undefined) {
    throw errors.validation(
      'A bill status is set by posting or reversing it, not by asking for one. Nothing has been saved.',
      { fieldErrors: { status: 'Remove the status from the request.' } },
    );
  }
  if (input.billNumber !== undefined) {
    throw errors.validation(
      'Bill numbers are allocated by the server, in sequence, so two people cannot be given the '
      + 'same one. Nothing has been saved.',
      { fieldErrors: { billNumber: 'Remove the bill number from the request.' } },
    );
  }
  for (const field of ['subtotal', 'total'] as const) {
    if (input[field] !== undefined) {
      throw errors.validation(
        'Bill totals are computed by the server from the lines. A total sent with the request would '
        + 'be the client deciding what the business owes. Nothing has been saved.',
        { fieldErrors: { [field]: 'Remove this — the server derives it from the lines.' } },
      );
    }
  }
}

/**
 * The currency a bill may be recorded in.
 *
 * Only the company's functional currency. A foreign-currency bill needs an
 * exchange rate, and rates are browser-resident — so the server would be
 * recording a converted figure it cannot justify, and an exchange difference
 * nobody computed. Refused rather than converted at 1.0.
 */
function assertFunctionalCurrency(requested: string | undefined, functional: string): void {
  if (!requested) return;
  if (requested.trim().toUpperCase() !== functional.toUpperCase()) {
    throw errors.validation(
      `This bill is in ${requested.toUpperCase()}, but only ${functional} bills can be held on the `
      + 'server yet: exchange rates and exchange differences are still kept in the browser, so the '
      + 'server cannot justify a converted amount. Nothing has been saved.',
      { fieldErrors: { currency: `Record this bill in ${functional}.` } },
    );
  }
}

function assertDates(input: BillInput): { billDate: string; postingDate: string; dueDate: string } {
  const billDate = input.billDate ?? '';
  if (!ISO_DATE.test(billDate)) {
    throw errors.validation('billDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { billDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  const dueDate = input.dueDate ?? '';
  if (!ISO_DATE.test(dueDate)) {
    throw errors.validation('dueDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { dueDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  if (dueDate < billDate) {
    throw errors.validation('The due date cannot fall before the bill date.', {
      fieldErrors: { dueDate: 'Choose a date on or after the bill date.' },
    });
  }
  /*
   * The posting date DEFAULTS to the bill date, which is the audited browser
   * behaviour (`bill.postingDate || bill.billDate`). It is what the ledger
   * posts on and what period locks are enforced against, so it is stored
   * explicitly rather than recomputed at every read.
   *
   * Payment terms do NOT derive the due date. No such rule exists in this
   * product — the browser defaults the due date to the bill date and lets the
   * user set it — and inventing one here would silently move every bill's due
   * date.
   */
  const postingDate = input.postingDate ?? billDate;
  if (!ISO_DATE.test(postingDate)) {
    throw errors.validation('postingDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { postingDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  return { billDate, postingDate, dueDate };
}

/* ══ Calculation ═══════════════════════════════════════════════════════════ */

interface ComputedLine {
  input: BillLineInput;
  discountAmount: Money.Amount;
  /** quantity x unitPrice, before discount. */
  lineSubtotal: Money.Amount;
  /** The discounted line amount — tax-bearing, before any split. */
  lineNet: Money.Amount;
  /** What the SERVER resolved, or null when the line names no code. */
  tax: ResolvedTax | null;
  /** What the line's own account is debited. */
  taxableAmount: Money.Amount;
  taxAmount: Money.Amount;
  /** taxable + tax — what the supplier is owed for this line. */
  grossAmount: Money.Amount;
}

function amount(value: string | null | undefined, field: string): Money.Amount {
  try {
    return Money.toAmount(value, field);
  } catch (error) {
    if (error instanceof Money.MoneyError) throw errors.validation(error.message);
    throw error;
  }
}

/**
 * Every total, from the lines.
 *
 * ══ The audited discount semantics, exactly ══════════════════════════════════
 *
 *   lineSubtotal = quantity x unitPrice          (GROSS, before discount)
 *   discount     = % of lineSubtotal, or a fixed amount, clamped to [0, gross]
 *   lineNet      = lineSubtotal - discount
 *   subtotal     = sum of lineSubtotal           (gross)
 *   total        = subtotal - discountTotal
 *
 * `subtotal` is the GROSS sum and the discount is subtracted at the document
 * level, which is what `calculateBillTotals` does. Storing the net in
 * `subtotal` and ALSO subtracting the discount would halve every discounted
 * bill, and it balances, so nothing would catch it but a reader.
 *
 * A discount larger than its line is CLAMPED rather than refused, because that
 * is the established browser behaviour; a NEGATIVE one is refused, because it
 * is not a discount.
 */
async function computeTotals(
  trx: Executor,
  actor: AccountingActor,
  lines: BillLineInput[],
  options: { decimals: number; taxPointDate: string },
): Promise<{
  computed: ComputedLine[];
  subtotal: Money.Amount;
  discountTotal: Money.Amount;
  taxTotal: Money.Amount;
  total: Money.Amount;
}> {
  const { decimals, taxPointDate } = options;

  /*
   * Resolved ONCE per distinct code, so a ten-line bill cannot end up with two
   * answers for one code because a rate version changed between two queries.
   * `'purchase'` is the usage: a sales-only code is refused here, by §3.
   */
  const codeIds = [...new Set(
    lines.map((line) => line.taxCodeId).filter((id): id is string => Boolean(id)),
  )];
  const resolved = new Map<string, ResolvedTax>();
  for (const codeId of codeIds) {
    resolved.set(codeId, await resolveTaxForDate(trx, actor, codeId, taxPointDate, 'purchase'));
  }

  const computed: ComputedLine[] = lines.map((line, index) => {
    const at = index + 1;
    const quantity = amount(line.quantity ?? '0', `line ${at} quantity`);
    const unitPrice = amount(line.unitPrice ?? '0', `line ${at} unitPrice`);
    if (Money.isNegative(quantity)) throw errors.validation(`Line ${at}: quantity cannot be negative.`);
    if (Money.isNegative(unitPrice)) throw errors.validation(`Line ${at}: unit price cannot be negative.`);

    /* Quantity is a count, not money — multiply at scale and divide back. */
    const gross = Money.roundTo(Money.multiply(quantity, unitPrice), decimals);

    const discountValue = amount(line.discountValue ?? '0', `line ${at} discountValue`);
    if (Money.isNegative(discountValue)) {
      throw errors.validation(`Line ${at}: a discount cannot be negative.`, {
        fieldErrors: { [`lines.${at}.discountValue`]: 'Enter zero or more.' },
      });
    }
    if (line.discountType && line.discountType !== 'percentage' && line.discountType !== 'amount') {
      throw errors.validation(
        `Line ${at}: "${line.discountType}" is not a discount this server supports. `
        + 'Use a percentage or a fixed amount. Nothing has been saved.',
        { fieldErrors: { [`lines.${at}.discountType`]: 'Choose percentage or amount.' } },
      );
    }

    let discountAmount = Money.ZERO;
    if (Money.isPositive(discountValue)) {
      discountAmount = line.discountType === 'amount'
        ? Money.roundTo(discountValue, decimals)
        : Money.roundTo(Money.multiply(gross, discountValue) / 100n, decimals);
    }
    /* Clamped to the line, as the browser calculator does. */
    if (discountAmount > gross) discountAmount = gross;

    const lineNet = gross - discountAmount;

    /*
     * The tax, from the code the line names and nothing else. A line with no
     * code bears no tax, and that is NOT the same as a zero-rated purchase —
     * which is why the category is only ever recorded when a code supplied it.
     */
    const tax = line.taxCodeId ? resolved.get(line.taxCodeId) ?? null : null;
    if (!tax) {
      return {
        input: line, discountAmount, lineSubtotal: gross, lineNet,
        tax: null, taxableAmount: lineNet, taxAmount: Money.ZERO, grossAmount: lineNet,
      };
    }

    /*
     * The DISCOUNTED line amount is the tax base — discount first, then tax,
     * which is the order `calculateInvoiceLine` established and S2c kept.
     *
     * EXCLUSIVE: `lineNet` is the net; tax is added on top and the supplier is
     * owed more. INCLUSIVE: `lineNet` is what the supplier is owed; the tax is
     * extracted from inside it and the expense is the remainder. Getting that
     * backwards overcharges the supplier by exactly the rate.
     */
    const result = SalesTax.calculateTaxLine({
      lineAmount: lineNet,
      rate: tax.rate,
      category: tax.category,
      method: tax.method,
      decimals,
    });

    return {
      input: line,
      discountAmount,
      lineSubtotal: gross,
      lineNet,
      tax,
      taxableAmount: result.taxableAmount,
      taxAmount: result.taxAmount,
      grossAmount: result.grossAmount,
    };
  });

  const subtotal = Money.sum(computed.map((c) => c.lineSubtotal));
  const discountTotal = Money.sum(computed.map((c) => c.discountAmount));
  const taxTotal = Money.sum(computed.map((c) => c.taxAmount));
  /* What the supplier is owed: every line's gross. For an exclusive line that
   * is net + tax; for an inclusive one it is the amount originally entered. */
  const total = Money.sum(computed.map((c) => c.grossAmount));
  return { computed, subtotal, discountTotal, taxTotal, total };
}

/* ══ Accounts ══════════════════════════════════════════════════════════════ */

/**
 * What a bill line may debit.
 *
 * ══ Why the type is checked at all ═══════════════════════════════════════════
 *
 * The browser requires only a posting (leaf) account, with no type rule. That
 * permits a bill that debits revenue, or a bank account — the first overstates
 * income, the second records a payment that never left the bank. Both balance,
 * so neither is caught by anything downstream.
 *
 * P2 therefore accepts EXPENSE and ASSET only. An asset debit is legitimate for
 * a non-inventory purchase, and it does NOT claim that the Fixed Assets or
 * Inventory subledger was updated — no register row is created and no stock
 * moves, which is why a stocked line is refused by shape before this is reached.
 *
 * A CASH-classified asset is refused: paying a supplier is a payment, and P2
 * creates none.
 */
function assertLineAccount(account: AccountRecord | undefined, at: number): void {
  if (!account) {
    throw errors.validation(
      `Line ${at}: that account does not exist in these books.`,
      { fieldErrors: { [`lines.${at}.accountId`]: "Choose an account from this company's chart." } },
    );
  }

  if (account.accountType !== 'expense' && account.accountType !== 'asset') {
    throw errors.validation(
      `Line ${at}: a bill line debits an expense or a non-inventory asset. `
      + `${account.accountCode} (${account.accountName}) is ${account.accountType}, and debiting it `
      + 'here would record a purchase as something it is not. Nothing has been saved.',
      { fieldErrors: { [`lines.${at}.accountId`]: 'Choose an expense or asset account.' } },
    );
  }

  if (account.cashClassification && account.cashClassification !== 'none') {
    throw errors.validation(
      `Line ${at}: ${account.accountCode} (${account.accountName}) is a cash or bank account. `
      + 'Paying a supplier is a payment, not a bill line, and payments are not on the server yet. '
      + 'Nothing has been saved.',
      { fieldErrors: { [`lines.${at}.accountId`]: 'Choose an expense or non-cash asset account.' } },
    );
  }

  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `Line ${at}: ${verdict.message}`,
      { fieldErrors: { [`lines.${at}.accountId`]: 'Choose an active, postable account.' } },
    );
  }
}

async function assertLineAccountsArePostable(
  db: Executor,
  actor: AccountingActor,
  lines: BillLineInput[],
): Promise<void> {
  const ids = lines.map((line) => line.accountId).filter(Boolean);
  if (ids.length !== lines.length) throw errors.validation('Every line needs an account.');

  /* The same loader the ledger uses, so a bill and a journal cannot disagree
   * about whether an account may receive a posting. */
  const accounts = await loadAccountsForPosting(db, actor.organizationId, actor.companyId, ids);
  for (const [index, line] of lines.entries()) {
    assertLineAccount(accounts.get(line.accountId), index + 1);
  }
}

/**
 * The supplier this bill is owed to, and the payable it credits.
 *
 * Read from the supplier's own P1 profile rather than the request. A caller who
 * named a different payable would balance its own entry while leaving the real
 * liability understated — and a later payment, which debits whatever the bill
 * recorded, would then clear something nobody owed.
 */
async function resolveSupplierAndPayable(
  trx: Executor,
  actor: AccountingActor,
  supplierId: string,
): Promise<{ payableAccountId: string; legalName: string }> {
  const party = await trx
    .selectFrom('business_parties')
    .select(['id', 'legal_name', 'is_supplier', 'status'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!party) {
    throw errors.validation(
      'That supplier does not exist in these books. A durable bill may only name a supplier this '
      + "company owns — which is what stops one company's bill being owed to another's supplier.",
      { fieldErrors: { supplierId: 'Choose a supplier from this company.' } },
    );
  }
  if (!party.is_supplier) {
    throw errors.validation(
      `${party.legal_name} is in this directory but does not hold the supplier role, so a bill `
      + 'cannot be owed to them. Give the party the supplier role first.',
      { fieldErrors: { supplierId: 'Choose a party that is a supplier.' } },
    );
  }
  if (party.status === 'archived') {
    throw errors.validation(
      `${party.legal_name} is archived and cannot be put on a new bill. Bills already recorded `
      + 'against them are untouched, which is the difference between archiving and deleting.',
      { fieldErrors: { supplierId: 'Choose an active supplier.' } },
    );
  }

  const profile = await trx
    .selectFrom('business_party_supplier_profiles')
    .select('default_payable_account_id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', '=', supplierId)
    .executeTakeFirst();

  const payableAccountId = profile?.default_payable_account_id;
  if (!payableAccountId) {
    throw errors.validation(
      `${party.legal_name} has no accounts payable account set, so there is nothing for this bill `
      + 'to credit. What the business owes a supplier is a liability; set the payable account on '
      + 'the supplier record and post again. Nothing has been saved.',
      { fieldErrors: { supplierId: 'Set a payable account on the supplier record.' } },
    );
  }

  return { payableAccountId, legalName: party.legal_name };
}

/**
 * The payable checked AT POSTING, not only when it was configured.
 *
 * An account can be archived, blocked, deactivated or given a child between the
 * supplier being set up and the bill being posted, and crediting one the ledger
 * would refuse from any other door is exactly the inconsistency this catches.
 */
async function assertPayablePostable(
  trx: Executor,
  actor: AccountingActor,
  payableAccountId: string,
  supplierName: string,
): Promise<void> {
  const accounts = await loadAccountsForPosting(
    trx, actor.organizationId, actor.companyId, [payableAccountId],
  );
  const account = accounts.get(payableAccountId);

  if (!account) {
    throw errors.validation(
      `The payable account for ${supplierName} is not an account in these books. Nothing has been saved.`,
    );
  }
  if (account.accountType !== 'liability') {
    throw errors.validation(
      `The payable account for ${supplierName} is ${account.accountType}, not a liability. What the `
      + 'business owes is a liability; crediting anything else misstates every statement it appears '
      + 'in. Nothing has been saved.',
    );
  }
  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `The payable account for ${supplierName} cannot receive postings: ${verdict.message} `
      + 'Nothing has been saved.',
    );
  }
}

/* ══ Numbering ═════════════════════════════════════════════════════════════ */

/**
 * The next internal bill number, allocated at DRAFT CREATION.
 *
 * That is where the browser allocates it, and moving it to posting would change
 * what a draft shows and how gaps arise — numbering policy, not this slice's to
 * change.
 *
 * The advisory lock keys on the COMPANY, so two companies under one subscriber
 * number their bills independently and concurrently. The sequence is HELD, never
 * derived from a MAX: counting existing bills reuses a number after a deletion,
 * and a reused bill number is two documents with one identity.
 */
async function allocateBillNumber(
  trx: Trx,
  actor: AccountingActor,
  issuingEntityId: string,
  billDate: string,
): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext(${`bill_number:${actor.organizationId}:${actor.companyId}:${issuingEntityId}`}))`
    .execute(trx);

  const existing = await trx
    .selectFrom('bill_numbering').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('issuing_entity_id', '=', issuingEntityId)
    .executeTakeFirst();

  const config = existing ?? {
    prefix: 'BILL-', include_year: true, sequence_length: 4, next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('bill_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      issuing_entity_id: issuingEntityId,
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('bill_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('issuing_entity_id', '=', issuingEntityId)
      .execute();
  }

  const year = config.include_year ? `${billDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

async function writeAudit(
  trx: Trx,
  actor: AccountingActor,
  input: {
    billId: string;
    action: string;
    detail?: Record<string, unknown>;
    previousVersion?: number | null;
    resultingVersion?: number | null;
  },
): Promise<void> {
  await trx.insertInto('bill_audit_events').values({
    organization_id: actor.organizationId,
    company_id: actor.companyId,
    bill_id: input.billId,
    action: input.action,
    detail: JSON.stringify(input.detail ?? {}),
    previous_version: input.previousVersion ?? null,
    resulting_version: input.resultingVersion ?? null,
    actor_user_id: actor.userId,
    actor_name: actor.name,
  } as never).execute();
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

async function loadBill(db: Executor, actor: AccountingActor, id: string): Promise<BillRecord> {
  const row = await db.selectFrom('bills').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Bill');

  const lines = await db.selectFrom('bill_lines').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('bill_id', '=', id)
    .orderBy('line_number', 'asc')
    .execute();

  return toBill(row, lines);
}

export const getBill = loadBill;

export interface ListBillsQuery {
  status?: SupplierBillStatus;
  supplierId?: string;
  search?: string;
  limit?: number;
}

export async function listBills(
  db: Executor,
  actor: AccountingActor,
  query: ListBillsQuery = {},
): Promise<BillRecord[]> {
  let builder = db.selectFrom('bills').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.supplierId) builder = builder.where('supplier_id', '=', query.supplierId);

  const search = (query.search ?? '').trim().toLowerCase();
  if (search) {
    const pattern = `%${search}%`;
    builder = builder.where((eb) => eb.or([
      eb(sql`lower(bill_number)`, 'like', pattern),
      eb(sql`lower(supplier_invoice_number)`, 'like', pattern),
      eb(sql`lower(memo)`, 'like', pattern),
    ]));
  }

  const rows = await builder
    .orderBy('bill_date', 'desc')
    .orderBy('bill_number', 'desc')
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 200))
    .execute();

  if (rows.length === 0) return [];

  const lines = await db.selectFrom('bill_lines').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('bill_id', 'in', rows.map((row) => row.id))
    .orderBy('line_number', 'asc')
    .execute();

  const linesBy = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesBy.get(line.bill_id) ?? [];
    list.push(line);
    linesBy.set(line.bill_id, list);
  }

  return rows.map((row) => toBill(row, linesBy.get(row.id) ?? []));
}

export async function billHistory(
  db: Executor,
  actor: AccountingActor,
  id: string,
): Promise<Array<{ action: string; actorName: string; at: string; detail: Record<string, unknown> }>> {
  await loadBill(db, actor, id);
  const rows = await db.selectFrom('bill_audit_events').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('bill_id', '=', id)
    .orderBy('at', 'desc')
    .limit(200)
    .execute();

  return rows.map((row) => ({
    action: row.action,
    actorName: row.actor_name,
    at: iso(row.at) ?? '',
    detail: (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail) as Record<string, unknown>,
  }));
}

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

async function functionalCurrencyOf(db: Executor, organizationId: string): Promise<string> {
  const org = await db.selectFrom('organizations').select('base_currency')
    .where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization');
  return org.base_currency;
}

async function replaceLines(
  trx: Trx,
  actor: AccountingActor,
  billId: string,
  computed: ComputedLine[],
  decimals: number,
): Promise<void> {
  await trx.deleteFrom('bill_lines')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('bill_id', '=', billId)
    .execute();

  for (const [index, line] of computed.entries()) {
    const value = line.input;
    if (value.unitPrice !== undefined
        && Money.exceedsPrecision(amount(value.unitPrice, 'unitPrice'), decimals)) {
      throw errors.validation(
        `Line ${index + 1}: unitPrice carries more decimal places than this currency allows.`,
      );
    }
    await trx.insertInto('bill_lines').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      bill_id: billId,
      line_number: index + 1,
      description: value.description ?? '',
      account_id: value.accountId,
      quantity: value.quantity ?? '0',
      unit: value.unit ?? '',
      unit_price: value.unitPrice ?? '0',
      discount_type: value.discountType ?? null,
      discount_value: value.discountValue ?? null,
      discount_amount: Money.toDecimalString(line.discountAmount),
      line_subtotal: Money.toDecimalString(line.lineSubtotal),
      line_net: Money.toDecimalString(line.lineNet),
      /*
       * The code and the figures the SERVER resolved, never the ones the
       * request carried — those are refused at the boundary. The snapshot
       * columns beside these stay empty until posting, because until then
       * nothing is frozen.
       */
      tax_code_id: value.taxCodeId ?? null,
      tax_rate: line.tax ? Money.toDecimalString(line.tax.rate) : '0',
      taxable_amount: Money.toDecimalString(line.taxableAmount),
      tax_amount: Money.toDecimalString(line.taxAmount),
      gross_amount: Money.toDecimalString(line.grossAmount),
    } as never).execute();
  }
}

export async function createDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: BillInput,
): Promise<BillRecord> {
  const dates = assertDates(input);
  if (!input.supplierId) throw errors.validation('A supplier is required.', {
    fieldErrors: { supplierId: 'Choose the supplier this bill is from.' },
  });
  if (!input.issuingEntityId) throw errors.validation('An issuing entity is required.');
  if (!input.lines || input.lines.length === 0) {
    throw errors.validation('A bill needs at least one line.');
  }

  /* Refused before any write, so a rejected bill leaves nothing behind. */
  assertWithinBoundary(input);

  return db.transaction().execute(async (trx) => {
    await resolveSupplierAndPayable(trx, actor, input.supplierId!);
    await assertLineAccountsArePostable(trx, actor, input.lines!);

    const currency = await functionalCurrencyOf(trx, actor.organizationId);
    assertFunctionalCurrency(input.currency, currency);
    const decimals = monetaryDecimalsFor(currency);

    /*
     * The tax point is the bill's POSTING date — what the ledger posts on and
     * what period locks are enforced against. Resolving tax on anything else
     * would let the rate and the accounting period disagree about when the
     * purchase happened.
     */
    const { computed, subtotal, discountTotal, taxTotal, total } =
      await computeTotals(trx, actor, input.lines!, { decimals, taxPointDate: dates.postingDate });
    const billNumber = await allocateBillNumber(trx, actor, input.issuingEntityId!, dates.billDate);

    const created = await trx.insertInto('bills').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      issuing_entity_id: input.issuingEntityId,
      supplier_id: input.supplierId,
      bill_number: billNumber,
      supplier_invoice_number: input.supplierInvoiceNumber ?? '',
      status: 'draft',
      bill_date: dates.billDate,
      posting_date: dates.postingDate,
      due_date: dates.dueDate,
      currency,
      memo: input.memo ?? '',
      subtotal: Money.toDecimalString(subtotal),
      discount_total: Money.toDecimalString(discountTotal),
      tax_total: Money.toDecimalString(taxTotal),
      total: Money.toDecimalString(total),
      created_by: actor.userId,
      updated_by: actor.userId,
    } as never).returning('id').executeTakeFirstOrThrow();

    await replaceLines(trx, actor, created.id, computed, decimals);
    await writeAudit(trx, actor, {
      billId: created.id, action: 'BILL_CREATED', resultingVersion: 1,
      detail: { billNumber, supplierId: input.supplierId },
    });

    return loadBill(trx, actor, created.id);
  });
}

async function lockBill(
  trx: Trx,
  actor: AccountingActor,
  id: string,
  expectedVersion: number | undefined,
): Promise<{
  id: string; version: number; status: SupplierBillStatus; supplier_id: string;
  bill_number: string; supplier_invoice_number: string; issuing_entity_id: string;
  posting_date: string | Date; currency: string; journal_entry_id: string | null;
}> {
  const { rows } = await sql<{
    id: string; version: number; status: SupplierBillStatus; supplier_id: string;
    bill_number: string; supplier_invoice_number: string; issuing_entity_id: string;
    posting_date: string | Date; currency: string; journal_entry_id: string | null;
  }>`
    SELECT id, version, status, supplier_id, bill_number, supplier_invoice_number,
           issuing_entity_id, posting_date, currency, journal_entry_id
      FROM bills
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND id = ${id}
     FOR UPDATE
  `.execute(trx);

  const row = rows[0];
  if (!row) throw errors.notFound('Bill');
  if (typeof expectedVersion !== 'number') {
    throw errors.validation(
      'This change did not carry the version it was based on, so the server cannot tell whether '
      + 'somebody else has already changed the bill. Reload and try again.',
      { fieldErrors: { expectedVersion: 'Reload the bill and retry.' } },
    );
  }
  if (Number(row.version) !== expectedVersion) {
    throw errors.conflict(
      'This bill was changed by another user while you were editing it. Reload to see their change '
      + 'before saving yours.',
    );
  }
  return { ...row, version: Number(row.version) };
}

export async function updateDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  input: BillInput,
  options: MutationOptions,
): Promise<BillRecord> {
  const dates = assertDates(input);
  if (!input.lines || input.lines.length === 0) {
    throw errors.validation('A bill needs at least one line.');
  }
  assertWithinBoundary(input);

  return db.transaction().execute(async (trx) => {
    const current = await lockBill(trx, actor, id, options.expectedVersion);
    if (!EDITABLE.includes(current.status)) {
      throw errors.conflict(
        `This bill is ${current.status} and can no longer be edited. A posted bill is accounting `
        + 'history; reverse it and record a corrected one.',
      );
    }

    if (input.supplierId) await resolveSupplierAndPayable(trx, actor, input.supplierId);
    await assertLineAccountsArePostable(trx, actor, input.lines!);

    const decimals = monetaryDecimalsFor(current.currency);
    assertFunctionalCurrency(input.currency, current.currency);
    /*
     * A DRAFT recalculates on every save, and only a draft. Leaving one on a
     * superseded rate would post tax nobody charges any more; a POSTED bill
     * never reaches here, because `EDITABLE` stops it above.
     */
    const { computed, subtotal, discountTotal, taxTotal, total } =
      await computeTotals(trx, actor, input.lines!, { decimals, taxPointDate: dates.postingDate });

    await trx.updateTable('bills').set({
      supplier_id: input.supplierId ?? current.supplier_id,
      supplier_invoice_number: input.supplierInvoiceNumber ?? '',
      bill_date: dates.billDate,
      posting_date: dates.postingDate,
      due_date: dates.dueDate,
      memo: input.memo ?? '',
      subtotal: Money.toDecimalString(subtotal),
      discount_total: Money.toDecimalString(discountTotal),
      tax_total: Money.toDecimalString(taxTotal),
      total: Money.toDecimalString(total),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await replaceLines(trx, actor, id, computed, decimals);
    await writeAudit(trx, actor, {
      billId: id, action: 'BILL_UPDATED',
      previousVersion: current.version, resultingVersion: current.version + 1,
    });

    return loadBill(trx, actor, id);
  });
}

export async function deleteDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const current = await lockBill(trx, actor, id, options.expectedVersion);
    if (current.status !== 'draft') {
      throw errors.conflict(
        `This bill is ${current.status} and cannot be deleted. A posted bill is removed from the `
        + 'books by reversing it, which leaves both entries visible — deleting one would leave a '
        + 'journal no document explains.',
      );
    }
    await trx.deleteFrom('bills')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();
  });
}

/**
 * A supplier reference already recorded against this supplier.
 *
 * ══ Refused, but overridable — and why it is not an index ════════════════════
 *
 * The audited behaviour refuses a duplicate at POSTING and lets a user override
 * it explicitly, because the same supplier legitimately reissues a reference
 * after a credit, and a business that cannot record that is stuck. A UNIQUE
 * index would make the documented override unrepresentable, so the rule lives
 * here where an acknowledgement can be part of the request.
 *
 * Drafts and reversed bills are ignored, exactly as the browser check does: a
 * draft has not claimed the reference and a reversal gave it back.
 */
async function assertSupplierReferenceFree(
  trx: Trx,
  actor: AccountingActor,
  input: { supplierId: string; supplierInvoiceNumber: string; excludeBillId: string },
  override: boolean,
): Promise<void> {
  const reference = input.supplierInvoiceNumber.trim();
  if (!reference || override) return;

  const { rows } = await sql<{ bill_number: string }>`
    SELECT bill_number FROM bills
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND supplier_id = ${input.supplierId}
       AND id <> ${input.excludeBillId}
       AND status = 'posted'
       AND lower(btrim(supplier_invoice_number)) = ${reference.toLowerCase()}
     LIMIT 1
  `.execute(trx);

  if (rows[0]) {
    throw errors.conflict(
      `Supplier invoice "${reference}" is already recorded on bill ${rows[0].bill_number}. `
      + 'Paying the same supplier document twice is the mistake this catches. If it really is a '
      + 'separate document, post it again confirming the duplicate.',
    );
  }
}

/** Input tax owed per control account, with the codes that contributed. */
function groupTaxByAccount(
  lines: ComputedLine[],
  inputAccounts: Map<string, string>,
): { accountId: string; amount: Money.Amount; codes: string[] }[] {
  const byAccount = new Map<string, { amount: Money.Amount; codes: Set<string> }>();
  for (const line of lines) {
    if (!line.tax || Money.isZero(line.taxAmount)) continue;
    const accountId = inputAccounts.get(line.tax.taxCodeId);
    if (!accountId) continue;
    const entry = byAccount.get(accountId) ?? { amount: Money.ZERO, codes: new Set<string>() };
    entry.amount = Money.add(entry.amount, line.taxAmount);
    entry.codes.add(line.tax.code);
    byAccount.set(accountId, entry);
  }
  return [...byAccount.entries()].map(([accountId, entry]) => ({
    accountId, amount: entry.amount, codes: [...entry.codes].sort(),
  }));
}

/** The one input account this bill used, or null when it used several. */
function singleInputAccountOf(inputAccounts: Map<string, string>): string | null {
  const accounts = new Set(inputAccounts.values());
  return accounts.size === 1 ? [...accounts][0]! : null;
}

/**
 * Post a bill: one transaction, or nothing.
 *
 * ══ What commits together ════════════════════════════════════════════════════
 *
 * The status change, the recomputed totals and lines, the payable actually
 * credited, the audit event and the posted journal. A crash between any two of
 * them would leave a posted journal with no document behind it — expense in the
 * ledger that nothing explains — or a bill claiming to be posted with no entry.
 *
 * ══ Retries cannot double-post ═══════════════════════════════════════════════
 *
 * The journal carries the source identity `(bill, <bill id>, post)` and the
 * unique index from migration 029 enforces it. A retry after a lost response
 * finds the journal already there; two concurrent posts resolve to one, because
 * the loser's INSERT is refused by the database rather than by a check two
 * connections can both pass.
 */
export async function postBill(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions & { overrideDuplicate?: boolean },
): Promise<BillRecord> {
  return db.transaction().execute(async (trx) => {
    const current = await lockBill(trx, actor, id, options.expectedVersion);

    if (current.status === 'posted') {
      throw errors.conflict('This bill is already posted.');
    }
    if (current.status !== 'draft') {
      throw errors.conflict(`A ${current.status} bill cannot be posted.`);
    }
    if (!current.supplier_invoice_number.trim()) {
      throw errors.validation(
        "The supplier's own invoice number is required before a bill can be posted. It is how this "
        + 'entry is matched to the document the supplier sent. Nothing has been saved.',
        { fieldErrors: { supplierInvoiceNumber: 'Enter the number on the supplier invoice.' } },
      );
    }

    await assertSupplierReferenceFree(trx, actor, {
      supplierId: current.supplier_id,
      supplierInvoiceNumber: current.supplier_invoice_number,
      excludeBillId: id,
    }, options.overrideDuplicate ?? false);

    const lines = await trx.selectFrom('bill_lines').selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('bill_id', '=', id)
      .orderBy('line_number', 'asc')
      .execute();
    if (lines.length === 0) {
      throw errors.validation('A bill needs at least one line before it can be posted.');
    }

    const { payableAccountId, legalName } =
      await resolveSupplierAndPayable(trx, actor, current.supplier_id);
    await assertPayablePostable(trx, actor, payableAccountId, legalName);

    /* Re-checked at posting: an account eligible when the draft was saved can
     * have been archived or blocked since. */
    await assertLineAccountsArePostable(
      trx, actor, lines.map((line) => ({ accountId: line.account_id } as BillLineInput)),
    );

    const decimals = monetaryDecimalsFor(current.currency);
    /* The authoritative tax date: the same date the ledger posts on. */
    const postingDateForTax = toCalendarDate(current.posting_date);

    /*
     * Recomputed from the stored line inputs, not read back from the stored
     * totals. The totals were computed when the draft was last saved; deriving
     * the journal from them would let a direct database edit decide what is
     * posted. Recomputing makes the entry, the stored totals and the lines one
     * answer by construction.
     */
    const computed = await computeTotals(trx, actor, lines.map((line) => ({
      accountId: line.account_id,
      taxCodeId: line.tax_code_id,
      quantity: String(line.quantity),
      unitPrice: String(line.unit_price),
      discountType: line.discount_type,
      discountValue: line.discount_value === null ? null : String(line.discount_value),
    })), { decimals, taxPointDate: postingDateForTax });

    /*
     * The input account for every taxable code, re-checked HERE. One eligible
     * when the code was configured can be archived, blocked or given a child
     * before the bill is posted.
     */
    const inputAccounts = new Map<string, string>();
    for (const line of computed.computed) {
      if (!line.tax || !SalesTax.chargesTax(line.tax.category)) continue;
      if (inputAccounts.has(line.tax.taxCodeId)) continue;
      inputAccounts.set(
        line.tax.taxCodeId,
        await assertInputAccountPostable(trx, actor, line.tax),
      );
    }

    if (!Money.isPositive(computed.total)) {
      throw errors.validation(
        'The bill total must be greater than zero. A bill for nothing records a liability that does '
        + 'not exist. Nothing has been saved.',
      );
    }

    const postingDate = toCalendarDate(current.posting_date);

    /*
     * Posted through the source-posting door, inside THIS transaction, so the
     * entry and the document below it commit together or not at all. Period
     * locks are enforced by `postSourceJournalIn` against this posting date.
     */
    const { journal } = await postSourceJournalIn(trx, actor, {
      sourceType: BILL_SOURCE_TYPE,
      sourceId: id,
      sourceEvent: BILL_POST_EVENT,
      transactionDate: postingDate,
      reference: current.supplier_invoice_number || current.bill_number,
      description: `Bill ${current.bill_number} — ${legalName}`,
      lines: [
        /*
         * Dr each line's own account for its NET amount.
         *
         * For an EXCLUSIVE line that is the amount entered; for an INCLUSIVE one
         * it is the amount left after the tax is extracted — the difference is
         * not the business's cost, it is a claim on an authority.
         */
        ...computed.computed.map((line, index) => ({
          accountId: lines[index]!.account_id,
          debit: Money.toDecimalString(line.taxableAmount),
          memo: lines[index]!.description || current.bill_number,
        })).filter((line) => line.debit !== Money.toDecimalString(Money.ZERO)),
        /*
         * Dr recoverable input tax, grouped per account.
         *
         * One leg per control account rather than one per line: several lines
         * sharing a code produce one debit, and two codes mapped to different
         * accounts stay apart — which is what makes a control-account
         * reconciliation possible at all.
         */
        ...groupTaxByAccount(computed.computed, inputAccounts).map(({ accountId, amount: taxAmount, codes }) => ({
          accountId,
          debit: Money.toDecimalString(taxAmount),
          memo: `Input tax ${codes.join(', ')} — ${current.bill_number}`,
        })),
        /* Cr the supplier's payable for what is owed, tax included. */
        {
          accountId: payableAccountId,
          credit: Money.toDecimalString(computed.total),
          memo: `Bill ${current.bill_number} · ${current.supplier_invoice_number}`,
        },
      ],
    });

    /*
     * ══ The snapshot freezes HERE ══════════════════════════════════════════
     *
     * Denormalised onto the line for the reason the invoice snapshot is:
     * `tax_code_id` alone would make a posted bill depend on mutable
     * configuration, so archiving the code, end-dating the rate or moving its
     * control account would change what the document says it was charged — and
     * the supplier's copy would not change with it.
     *
     * Every fact needed to reproduce the figure is copied: the code's identity
     * and name, which way it faced, the category, the method, the recoverability
     * treatment, the rate, WHICH rate version it came from, the base, the tax,
     * the recoverable amount, the gross, the account it debited and the date the
     * rate was resolved on.
     */
    const capturedAt = new Date();
    for (const [index, line] of computed.computed.entries()) {
      const row = lines[index]!;
      const tax = line.tax;
      await trx.updateTable('bill_lines').set({
        taxable_amount: Money.toDecimalString(line.taxableAmount),
        tax_amount: Money.toDecimalString(line.taxAmount),
        /* Fully recoverable, always: partial recovery is refused at the
         * boundary, so the recoverable amount IS the tax. */
        recoverable_tax_amount: Money.toDecimalString(line.taxAmount),
        gross_amount: Money.toDecimalString(line.grossAmount),
        line_net: Money.toDecimalString(line.lineNet),
        ...(tax ? {
          tax_rate: Money.toDecimalString(SalesTax.effectiveRate(tax.rate, tax.category)),
          tax_rate_version_id: tax.rateVersionId,
          tax_code_code: tax.code,
          tax_code_name: tax.name,
          tax_direction: tax.direction,
          tax_category: tax.category,
          tax_calculation_method: tax.method,
          tax_recoverability: tax.recoverability,
          tax_rate_effective_from: tax.effectiveFrom,
          tax_rate_effective_to: tax.effectiveTo,
          tax_point_date: postingDateForTax,
          tax_account_id: inputAccounts.get(tax.taxCodeId) ?? null,
          tax_snapshot_at: capturedAt,
        } : {
          tax_rate: '0',
        }),
      } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', row.id)
        .execute();
    }

    await trx.updateTable('bills').set({
      status: 'posted',
      journal_entry_id: journal.id,
      /* Recorded so a later change to the supplier profile cannot restate a
       * posted document. */
      payable_account_id: payableAccountId,
      subtotal: Money.toDecimalString(computed.subtotal),
      discount_total: Money.toDecimalString(computed.discountTotal),
      tax_total: Money.toDecimalString(computed.taxTotal),
      total: Money.toDecimalString(computed.total),
      /* The single input account when unambiguous; null when several were used,
       * because then no one account can honestly name this bill's input tax. */
      input_tax_account_id: singleInputAccountOf(inputAccounts),
      posted_at: new Date(),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      billId: id, action: 'BILL_POSTED',
      previousVersion: current.version, resultingVersion: current.version + 1,
      detail: {
        journalEntryId: journal.id, payableAccountId,
        total: Money.toDecimalString(computed.total),
        taxTotal: Money.toDecimalString(computed.taxTotal),
      },
    });

    return loadBill(trx, actor, id);
  });
}

/**
 * Reverse a posted bill.
 *
 * ══ The audited model, unchanged ═════════════════════════════════════════════
 *
 * Posted-only, a reason is required, and a REVERSING journal is created — the
 * original entry and the original bill both stay exactly as they were. Nothing
 * deletes a journal, because a posted document that vanishes leaves a period
 * whose totals nobody can reproduce.
 */
export async function reverseBill(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions & { reason?: string },
): Promise<BillRecord> {
  const reason = (options.reason ?? '').trim();
  if (!reason) {
    throw errors.validation(
      'A reversal reason is required. A reversing entry is part of the audit trail, and one that '
      + 'does not say why is a correction nobody can explain later.',
      { fieldErrors: { reason: 'Say why this bill is being reversed.' } },
    );
  }

  return db.transaction().execute(async (trx) => {
    const current = await lockBill(trx, actor, id, options.expectedVersion);
    if (current.status === 'reversed') throw errors.conflict('This bill is already reversed.');
    if (current.status !== 'posted' || !current.journal_entry_id) {
      throw errors.conflict('Only a posted bill can be reversed.');
    }

    /*
     * ══ A paid bill is not reversible ════════════════════════════════════════
     *
     * Reversing it would debit accounts payable twice — once for the reversal,
     * once for the payment — against a single credit, understating what the
     * business owes and leaving a posted payment pointing at a document
     * reversed out of the books.
     *
     * The check reads under the row lock `lockBill` already holds, and every
     * path that posts, reallocates or reverses a payment takes that same lock
     * on each bill it touches before writing an allocation. So a payment
     * cannot appear between this check and the reversal below, and the two
     * cannot interleave in the other direction either.
     */
    await assertNoLiveAllocations(
      trx, actor, id, current.bill_number, monetaryDecimalsFor(current.currency),
    );

    /*
     * The JOURNAL's own version, read under the same transaction. `reverseJournalIn`
     * requires it and treats an omitted token as a caller that has not read the
     * record — last-write-wins is exactly what it exists to prevent — so the bill's
     * version cannot stand in for it.
     */
    const entry = await trx.selectFrom('journal_entries').select('version')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', current.journal_entry_id)
      .executeTakeFirst();
    if (!entry) throw errors.notFound('Journal entry');

    const { reversal } = await reverseJournalIn(trx, actor, current.journal_entry_id, {
      reason,
      expectedVersion: entry.version,
    });

    await trx.updateTable('bills').set({
      status: 'reversed',
      reversal_journal_entry_id: reversal.id,
      reversal_reason: reason,
      reversed_at: new Date(),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      billId: id, action: 'BILL_REVERSED',
      previousVersion: current.version, resultingVersion: current.version + 1,
      detail: { reason, reversalJournalEntryId: reversal.id },
    });

    return loadBill(trx, actor, id);
  });
}
