/**
 * What actually stands in the way of amending a posted document.
 *
 * ── Why this is a registry, not a switch ─────────────────────────────────────
 * The same reason `journalDependencies` is one. Every module that consumes a
 * posted document is a potential blocker and the set grows; a hand-written
 * switch is correct the day it is written, and the next module is the one
 * nobody remembers to add — silently, because the assessment simply reports
 * "nothing in the way".
 *
 * So each probe is a value. Adding a module means adding a probe beside it, and
 * a probe that THROWS is reported as a blocker rather than as an absence: an
 * unanswerable question about whether something depends on this document is not
 * permission to restate it.
 *
 * ── Probes for modules Ledgora does not have ─────────────────────────────────
 * Bank reconciliation and external e-invoice clearance are named in the
 * requirement and do not exist in this deployment. They are registered here as
 * probes that can only return nothing today, exactly as `journalDependencies`
 * registers its absent modules: an empty result from a NAMED probe is the fact
 * "no such module", whereas leaving them out would silently claim the question
 * had been asked. When either lands, the probe body is the only thing to change.
 */
import type {
  AmendableDocumentType,
  AmendmentBlocker,
  AmendmentImpact,
  SettlementAllocationRef,
} from '@/types/documentAmendment';
import { isSupersededDocument } from '@/types/documentAmendment';
import type { Invoice } from '@/types/invoice';
import type { Bill, BillSupplierCredit } from '@/types/bill';
import type { CreditNote } from '@/types/creditNote';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { useInventoryStore, inventoryEnabled } from '@/store/inventoryStore';
import { useJournalStore } from '@/store/journalStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { canReverseMovement } from '@/lib/inventoryReversal';
import { balanceToleranceFor } from '@/lib/journalValidation';

/* ── The document, in the one shape every probe needs ─────────────────────── */

/**
 * The facts a probe reasons about, extracted once by the adapter for the
 * document's type. Probes never reach back into a typed document, so adding a
 * fifth document classification does not mean editing nine probes.
 */
export interface ProbeSubject {
  type: AmendableDocumentType;
  id: string;
  number: string;
  /** The date the period rules are evaluated against (posting date). */
  date: string;
  status: string;
  /** True when the document has actually reached the ledger. */
  posted: boolean;
  journalEntryId?: string;
  /** True when a later version already replaced it. */
  superseded: boolean;
  grandTotal: number;
  balanceDue: number;
  /** Every settlement recorded against it, whatever its source. */
  settlements: SettlementAllocationRef[];
  /** Inventory documents this document created. */
  inventoryDocumentIds: string[];
  /**
   * Any external fiscal identity the document carries — a clearance UUID, a QR
   * payload, a submission status. Empty in this deployment; see the probe.
   */
  externalFiscalIdentity?: string;
}

export interface ProbeResult {
  findings: AmendmentBlocker[];
  /** Fields the probe contributes to the impact summary. */
  impact?: Partial<AmendmentImpact>;
}

export interface AmendmentProbe {
  id: string;
  describes: string;
  probe: (subject: ProbeSubject) => ProbeResult;
}

const blocks = (
  kind: AmendmentBlocker['kind'],
  sourceLabel: string,
  message: string,
  correctiveWorkflow?: string,
): AmendmentBlocker => ({ kind, severity: 'blocks', sourceLabel, message, ...(correctiveWorkflow ? { correctiveWorkflow } : {}) });

const confirm = (
  kind: AmendmentBlocker['kind'],
  sourceLabel: string,
  message: string,
): AmendmentBlocker => ({ kind, severity: 'requires_confirmation', sourceLabel, message });

/* ── The probes ───────────────────────────────────────────────────────────── */

export const AMENDMENT_PROBES: readonly AmendmentProbe[] = [
  {
    id: 'document-state',
    describes: 'Whether this is a live posted document at all',
    probe: (subject) => {
      if (!subject.posted || !subject.journalEntryId) {
        return {
          findings: [
            blocks(
              'not_posted',
              subject.number,
              'This document has not been posted, so there is nothing to amend. Edit it with the ordinary editor and post it when it is right.',
              'Ordinary draft editing',
            ),
          ],
        };
      }
      if (subject.superseded) {
        return {
          findings: [
            blocks(
              'not_current',
              subject.number,
              'This version has already been superseded by a later amendment. Amend the current version instead — this one is history and stays as it is.',
            ),
          ],
        };
      }
      if (['void', 'reversed', 'superseded'].includes(subject.status)) {
        return {
          findings: [
            blocks(
              'not_current',
              subject.number,
              `This document is ${subject.status}. Its ledger effect has already been withdrawn, so record a new document rather than amending a withdrawn one.`,
              'Create a new document',
            ),
          ],
        };
      }
      return { findings: [] };
    },
  },

  {
    id: 'journal-entry',
    describes: 'The posted journal entry the document produced',
    probe: (subject) => {
      if (!subject.journalEntryId) return { findings: [] };
      const entry = useJournalStore.getState().entries.find((e) => e.id === subject.journalEntryId);
      if (!entry) {
        return {
          findings: [
            blocks(
              'indeterminate',
              subject.number,
              'The journal entry this document posted could not be found, so its reversal cannot be verified. The amendment is refused rather than guessed at.',
            ),
          ],
        };
      }
      if (entry.status !== 'posted') {
        return {
          findings: [
            blocks(
              'not_posted',
              entry.entryNumber,
              `Journal entry ${entry.entryNumber} is ${entry.status}, not posted. There is no posting to reverse.`,
            ),
          ],
        };
      }
      return {
        findings: [],
        impact: { originalJournalEntryId: entry.id, originalJournalEntryNumber: entry.entryNumber },
      };
    },
  },

  {
    id: 'tax-period',
    describes: 'Locked, filed or prepared tax periods covering the document date',
    probe: (subject) => {
      /*
       * Matched on the DATE alone, exactly as `journalDependencies` does. The
       * period store is keyed by entity and jurisdiction, but a document that
       * falls inside a filed return for any jurisdiction is inside a filed
       * return, and narrowing by a jurisdiction the document does not carry
       * would turn a real block into a miss.
       */
      const periods = useTaxPeriodStore
        .getState()
        .periods.filter((p) => subject.date >= p.periodStart && subject.date <= p.periodEnd);
      const findings: AmendmentBlocker[] = [];
      let periodLabel: string | undefined;
      let periodStatus: string | undefined;
      for (const period of periods) {
        const label = `Tax period ${period.periodStart} – ${period.periodEnd}`;
        periodLabel = label;
        periodStatus = period.status;
        if (period.status === 'filed') {
          findings.push(
            blocks(
              'filed_tax_return',
              label,
              `${label} has been filed. A document inside a filed return cannot be amended internally.`,
              'Raise a credit note or a supplier debit note in the current open period, and correct the return through period management.',
            ),
          );
        } else if (period.status === 'locked') {
          findings.push(
            blocks(
              'locked_period',
              label,
              `${label} is locked. Ledgora will not reopen a locked period to post a reversal — reopening is a separate, separately authorized act.`,
              'Reopen the period through period management, or correct in the current open period with a credit/debit note.',
            ),
          );
        } else if (period.status === 'prepared') {
          findings.push(
            confirm(
              'filed_tax_return',
              label,
              `${label} is prepared for filing. The reversal and the corrected posting will both land inside it, so the return must be re-prepared before it is filed.`,
            ),
          );
        }
      }
      return { findings, impact: { tax: { periodLabel, periodStatus } } };
    },
  },

  {
    id: 'external-einvoice',
    describes: 'External e-invoicing clearance (no integration in this deployment)',
    /*
     * Ledgora has no live JoFotara integration: `019_sales_invoices` says in
     * terms that it carries no clearance columns because the authority's
     * profile has not been read yet, and the only JoFotara code in the tree is
     * a MOCK the server refuses to enable in production. So there is no
     * document in this deployment that can carry a cleared identity.
     *
     * The probe is registered anyway, and it is not inert: if a document ever
     * arrives carrying an external fiscal identity — imported, or written by a
     * future integration — this refuses the amendment rather than letting a
     * cleared document be restated behind the authority's back. Nothing is ever
     * re-sent to an external system from here.
     */
    probe: (subject) => {
      const identity = (subject.externalFiscalIdentity ?? '').trim();
      if (!identity) return { findings: [], impact: { tax: { externalSubmission: undefined } } };
      return {
        findings: [
          blocks(
            'external_einvoice',
            subject.number,
            `This document carries an external fiscal identity (${identity}) issued by a tax authority. It cannot be replaced by an internal amendment, and Ledgora will not change its local status to make it look cancelled.`,
            'Issue a credit note or a supplier debit note through the authority’s own correction process.',
          ),
        ],
        impact: { tax: { externalSubmission: identity } },
      };
    },
  },

  {
    id: 'bank-reconciliation',
    describes: 'Bank reconciliation (module not present in this deployment)',
    /*
     * Registered deliberately, and empty for the same reason
     * `journalDependencies` registers its own: Ledgora has no
     * bank-reconciliation module, so "no reconciliation locks this settlement"
     * is a CHECKED answer rather than an unasked question. When the module
     * lands, a reconciled allocation becomes a `reconciled_settlement` blocker
     * here and nowhere else.
     */
    probe: () => ({ findings: [] }),
  },

  {
    id: 'settlement',
    describes: 'Payments, receipts, credit applications and refunds recorded against the document',
    probe: (subject) => {
      const settled = subject.settlements.reduce((sum, s) => sum + s.amount, 0);
      if (subject.settlements.length === 0) {
        return {
          findings: [],
          impact: {
            settlement: {
              grandTotal: subject.grandTotal,
              amountSettled: 0,
              balanceDue: subject.balanceDue,
              transferable: [],
              blocked: [],
            },
          },
        };
      }
      /*
       * Every settlement Ledgora can hold against these documents is an
       * ALLOCATION — a subledger link from a receipt, a payment, a credit note
       * or a refund that owns its own journal entry. Moving the link to the
       * replacement leaves the money, its posting and its document identity
       * exactly where they were, which is what the rule "do not change the
       * independent legal identity of existing payments or receipts" asks for.
       *
       * Whether the moved allocations still FIT is not knowable here — the
       * replacement's total does not exist until the operator has written it —
       * so it is re-checked against the corrected figures at commit time, where
       * an over-allocation refuses the whole transaction.
       */
      return {
        findings: [
          confirm(
            'reconciled_settlement',
            subject.number,
            `${subject.settlements.length} settlement record(s) totalling ${settled.toFixed(2)} are allocated to this document. `
            + 'Each keeps its own number, journal entry and bank posting; only the allocation moves to the amended document. '
            + 'If the corrected total is smaller than what is already settled, the amendment will be refused rather than over-allocate.',
          ),
        ],
        impact: {
          settlement: {
            grandTotal: subject.grandTotal,
            amountSettled: settled,
            balanceDue: subject.balanceDue,
            transferable: subject.settlements,
            blocked: [],
          },
        },
      };
    },
  },

  {
    id: 'inventory',
    describes: 'Stock movements and COGS the document created, and what has happened to that stock since',
    probe: (subject) => {
      if (subject.inventoryDocumentIds.length === 0 || !inventoryEnabled()) {
        return { findings: [], impact: { inventory: { documentIds: [], movementCount: 0, reversible: true } } };
      }
      const state = useInventoryStore.getState();
      const findings: AmendmentBlocker[] = [];
      let movementCount = 0;
      let reversible = true;
      let blockReason: string | undefined;

      for (const documentId of subject.inventoryDocumentIds) {
        const doc = state.documents.find((d) => d.id === documentId);
        if (!doc) continue;
        if (doc.status === 'reversed') continue;
        const movements = state.movements.filter((m) => doc.movementIds.includes(m.id));
        movementCount += movements.length;
        for (const movement of movements) {
          const warehouse = state.warehouses.find((w) => w.id === movement.warehouseId);
          const allowNegative =
            state.settings.negativeStockPolicy === 'allow' || !!warehouse?.allowNegativeStock;
          /*
           * The EXISTING reversal engine decides, not a rule restated here.
           * `canReverseMovement` is what refuses to unwind a receipt whose
           * stock has since been sold, transferred, consumed by manufacturing
           * or counted — and it refuses at the original cost, never at the
           * catalogue purchase price.
           */
          const check = canReverseMovement(movement, state.movements, allowNegative);
          if (!check.ok) {
            reversible = false;
            blockReason = check.error;
            findings.push(
              blocks(
                'inventory_dependency',
                `Stock movement ${movement.movementNumber}`,
                `${check.error} The amendment is refused because reversing this document would corrupt the valuation of stock that has already moved on.`,
                'Record a customer return, a supplier return or a stock adjustment for the difference, then raise a credit note or supplier debit note for the value.',
              ),
            );
          }
        }
      }

      if (movementCount > 0 && reversible) {
        findings.push(
          confirm(
            'inventory_dependency',
            subject.number,
            `${movementCount} stock movement(s) will be reversed at their ORIGINAL cost through the inventory reversal engine, and the amended document will post fresh movements. Valuation layers, warehouses and item costs are preserved.`,
          ),
        );
      }

      return {
        findings,
        impact: {
          inventory: {
            documentIds: subject.inventoryDocumentIds,
            movementCount,
            reversible,
            ...(blockReason ? { blockReason } : {}),
          },
        },
      };
    },
  },
];

/* ── Collection ───────────────────────────────────────────────────────────── */

export interface CollectedProbes {
  findings: AmendmentBlocker[];
  impact: AmendmentImpact;
}

/**
 * Run every probe and merge what they found.
 *
 * A probe that throws becomes a blocker. Reporting it as "nothing found" would
 * turn a crash in one module into permission to restate a document that module
 * depends on.
 */
export function collectAmendmentFindings(subject: ProbeSubject): CollectedProbes {
  const findings: AmendmentBlocker[] = [];
  const impact: AmendmentImpact = {
    settlement: {
      grandTotal: subject.grandTotal,
      amountSettled: 0,
      balanceDue: subject.balanceDue,
      transferable: [],
      blocked: [],
    },
    inventory: { documentIds: [], movementCount: 0, reversible: true },
    tax: {},
  };

  for (const probe of AMENDMENT_PROBES) {
    try {
      const result = probe.probe(subject);
      findings.push(...result.findings);
      if (result.impact?.originalJournalEntryId) impact.originalJournalEntryId = result.impact.originalJournalEntryId;
      if (result.impact?.originalJournalEntryNumber) impact.originalJournalEntryNumber = result.impact.originalJournalEntryNumber;
      if (result.impact?.settlement) Object.assign(impact.settlement, result.impact.settlement);
      if (result.impact?.inventory) Object.assign(impact.inventory, result.impact.inventory);
      if (result.impact?.tax) {
        for (const [key, value] of Object.entries(result.impact.tax)) {
          if (value !== undefined) (impact.tax as Record<string, unknown>)[key] = value;
        }
      }
    } catch {
      findings.push(
        blocks(
          'indeterminate',
          probe.describes,
          `The "${probe.describes}" check could not be completed, so this document cannot be amended safely right now.`,
        ),
      );
    }
  }

  return { findings, impact };
}

/* ── Subject builders, one per document classification ────────────────────── */

/** The inventory documents a source document created, found by kind + reference. */
export function inventoryDocumentsFor(kind: string, reference: string): string[] {
  if (!inventoryEnabled() || !reference) return [];
  /*
   * Matched on kind + reference rather than on an id stored on the document.
   * The issue/receipt paths have never written the inventory document id back
   * onto the invoice or bill, and adding that write now would change how
   * EXISTING documents are posted — which is precisely what this feature is
   * forbidden from doing. Reference is the invoice/bill/credit-note number,
   * which is unique within a company by construction.
   */
  return useInventoryStore
    .getState()
    .documents.filter((d) => d.kind === kind && d.reference === reference && d.status === 'posted')
    .map((d) => d.id);
}

export function invoiceSubject(invoice: Invoice): ProbeSubject {
  const settlements: SettlementAllocationRef[] = [];
  for (const payment of invoice.payments ?? []) {
    settlements.push({
      kind: payment.receiptId ? 'receipt' : 'direct',
      id: payment.id,
      label: payment.receiptId
        ? `Receipt allocation ${payment.reference || payment.id}`
        : `Payment ${payment.reference || payment.id}`,
      amount: payment.amount,
    });
  }
  if ((invoice.creditsApplied ?? 0) > balanceToleranceFor()) {
    for (const note of useCreditNoteStore.getState().creditNotes) {
      for (const application of note.applications ?? []) {
        if (application.invoiceId !== invoice.id || application.reversed) continue;
        settlements.push({
          kind: 'credit-note',
          id: application.id,
          label: `Credit note ${note.creditNoteNumber}`,
          amount: application.amount,
        });
      }
    }
  }
  return {
    type: 'invoice',
    id: invoice.id,
    number: invoice.invoiceNumber,
    date: invoice.issueDate,
    status: invoice.status,
    posted: !!invoice.journalEntryId && invoice.status !== 'draft',
    journalEntryId: invoice.journalEntryId,
    superseded: isSupersededDocument(invoice),
    grandTotal: invoice.grandTotal,
    balanceDue: invoice.balanceDue,
    settlements,
    inventoryDocumentIds: inventoryDocumentsFor('invoice-issue', invoice.invoiceNumber),
  };
}

export function billSubject(bill: Bill): ProbeSubject {
  const settlements: SettlementAllocationRef[] = [];
  for (const payment of bill.payments ?? []) {
    settlements.push({
      kind: payment.paymentId ? 'payment' : 'direct',
      id: payment.id,
      label: payment.paymentId
        ? `Payment allocation ${payment.reference || payment.id}`
        : `Payment ${payment.reference || payment.id}`,
      amount: payment.amount,
    });
  }
  for (const credit of bill.supplierCredits ?? []) {
    settlements.push({
      kind: 'supplier-credit',
      id: credit.id,
      label: `Supplier debit note ${credit.creditNumber}`,
      amount: credit.amount,
    });
  }
  return {
    type: 'bill',
    id: bill.id,
    number: bill.billNumber,
    date: bill.postingDate || bill.billDate,
    status: bill.status,
    posted: !!bill.journalEntryId && bill.status !== 'draft',
    journalEntryId: bill.journalEntryId,
    superseded: isSupersededDocument(bill),
    grandTotal: bill.grandTotal,
    balanceDue: bill.balanceDue,
    settlements,
    inventoryDocumentIds: inventoryDocumentsFor('bill-receipt', bill.billNumber),
  };
}

export function creditNoteSubject(note: CreditNote): ProbeSubject {
  const settlements: SettlementAllocationRef[] = [];
  for (const application of note.applications ?? []) {
    if (application.reversed) continue;
    settlements.push({
      kind: 'credit-note',
      id: application.id,
      label: `Applied to invoice ${application.invoiceId}`,
      amount: application.amount,
    });
  }
  for (const refund of note.refunds ?? []) {
    settlements.push({
      kind: 'direct',
      id: refund.id,
      label: `Refund ${refund.reference || refund.id}`,
      amount: refund.amount,
    });
  }
  return {
    type: 'credit-note',
    id: note.id,
    number: note.creditNoteNumber,
    date: note.issueDate,
    status: note.status,
    posted: !!note.journalEntryId && note.status !== 'draft',
    journalEntryId: note.journalEntryId,
    superseded: isSupersededDocument(note),
    grandTotal: note.grandTotal,
    balanceDue: note.remainingCredit,
    settlements,
    inventoryDocumentIds: inventoryDocumentsFor('customer-return', note.creditNoteNumber),
  };
}

/**
 * A supplier debit note.
 *
 * `supersededByDocumentId` lives on the credit sub-record itself, so a chain of
 * amended debit notes is readable from the bill that holds them.
 */
export function supplierDebitNoteSubject(credit: BillSupplierCredit): ProbeSubject {
  return {
    type: 'supplier-debit-note',
    id: credit.id,
    number: credit.creditNumber,
    date: credit.date,
    status: credit.supersededByDocumentId ? 'superseded' : 'posted',
    posted: !!credit.journalEntryId,
    journalEntryId: credit.journalEntryId,
    superseded: isSupersededDocument(credit),
    grandTotal: credit.amount,
    // A debit note settles the bill rather than carrying a balance of its own.
    balanceDue: 0,
    settlements: [],
    inventoryDocumentIds: inventoryDocumentsFor('supplier-return', credit.creditNumber),
  };
}
