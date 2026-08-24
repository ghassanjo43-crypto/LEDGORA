/**
 * Which backend holds a company's invoices, and whether it may be changed.
 *
 * ── Why the flag is per company ──────────────────────────────────────────────
 * Invoice numbers are allocated per issuing entity, under an advisory lock, on
 * the server; in the browser they are allocated from `usedNumbers()`. Those two
 * allocators cannot see each other. Flag two USERS of the same company onto
 * different backends and both will hand out the same next number — and once a
 * tax authority has cleared the first document bearing it, the second is
 * rejected. A company is therefore the smallest unit that can be switched
 * safely, because a company is the unit numbering is scoped to.
 *
 * ── Why the flag is derived, not typed in ────────────────────────────────────
 * The condition that matters is not "has an administrator ticked a box", it is
 * "are this company's invoices actually in the database yet". So the stored
 * value is the migration timestamp, and the backend is a function of it. There
 * is no way to express "use the server" for a company whose invoices were never
 * imported, because that state loses invoices.
 */
import type { Invoice } from '@/types/invoice';

export type InvoiceBackend = 'browser' | 'server';

/** What a company records about its own cutover. Stored on the company. */
export interface InvoiceBackendState {
  /** Set when `/api/invoices/import` reported success for this company. */
  invoicesMigratedAt?: string | null;
}

export function backendFor(state: InvoiceBackendState | undefined): InvoiceBackend {
  return state?.invoicesMigratedAt ? 'server' : 'browser';
}

/**
 * A reason a company cannot be switched over yet.
 *
 * These are gaps in what the SERVER can represent, not user errors. Each one
 * names a thing the browser invoice holds that `019_sales_invoices` has a
 * column for but no service path to write — so migrating would keep the column
 * empty and the screen would quietly lose data that used to be there.
 */
export type IneligibilityCode =
  | 'inventory_lines'
  | 'no_invoices';

export interface Ineligibility {
  code: IneligibilityCode;
  /** Shown to the person attempting the cutover. */
  message: string;
  /** Invoice numbers demonstrating the problem, for a "show me" affordance. */
  examples: string[];
}

export interface Eligibility {
  eligible: boolean;
  blockers: Ineligibility[];
}

const SAMPLE = 5;

function sample(invoices: Invoice[], predicate: (invoice: Invoice) => boolean): string[] {
  return invoices.filter(predicate).slice(0, SAMPLE).map((invoice) => invoice.invoiceNumber || '(draft)');
}

/**
 * May this company's invoices move to the server without losing anything?
 *
 * Deliberately conservative: it answers "is every feature these invoices
 * actually use representable server-side", not "does the schema have a column
 * for it". A company that has never recorded a payment in Ledgora passes even
 * though the server has no payment path, because nothing would be lost.
 */
export function assessEligibility(invoices: Invoice[]): Eligibility {
  const blockers: Ineligibility[] = [];

  if (invoices.length === 0) {
    return {
      eligible: false,
      blockers: [{
        code: 'no_invoices',
        message: 'This company has no invoices to migrate.',
        examples: [],
      }],
    };
  }

  /*
   * Issuing an invoice in the browser also posts stock movements
   * (`postInvoiceIssue`). The server's issue path posts the sales journal and
   * nothing else, so a migrated company would sell stock without depleting it.
   */
  const withInventory = sample(invoices, (invoice) =>
    invoice.lines.some((line) => Boolean(line.inventoryItemId)));
  if (withInventory.length > 0) {
    blockers.push({
      code: 'inventory_lines',
      message:
        'Some invoices sell inventory items. Issuing server-side does not move stock yet, '
        + 'so migrating now would leave stock overstated.',
      examples: withInventory,
    });
  }

  return { eligible: blockers.length === 0, blockers };
}
