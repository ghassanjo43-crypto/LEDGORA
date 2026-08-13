/**
 * The company currency is the transaction currency — the store-level rules.
 *
 * ══ What these prove, and what they deliberately do not ══════════════════════
 *
 * These prove that every ordinary transaction a user can create through the
 * application takes the COMPANY's currency, and that no editor's payload can
 * change it. They are not, and cannot be, a security boundary: the browser is
 * not one. `server/tests/accountingCurrencyPolicy.test.ts` proves the rule
 * where it is actually enforced — inside the write transaction, against a
 * caller with no interface at all.
 *
 * ══ The defect behind the policy ═════════════════════════════════════════════
 *
 * The old chain in three stores was
 *
 *     input.currency ?? entity.defaultCurrency ?? settings.baseCurrency
 *
 * and the seeded customers and suppliers carry USD. So a Jordanian company
 * raised dollar invoices and dollar bills with nobody choosing to, and with no
 * currency shown anywhere on the invoice form. That middle term is what these
 * tests exist to keep gone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useReceiptStore } from '@/store/receiptStore';
import {
  ORDINARY_TRANSACTION_EXCHANGE_RATE,
  describeCurrency,
  transactionCurrencyCode,
} from '@/lib/transactionCurrency';

/** Randa Trading keeps its books in Jordanian dinar. */
function companyKeepsBooksIn(code: string): void {
  useStore.setState((s) => ({ settings: { ...s.settings, baseCurrency: code } }));
}

/** A customer and a supplier whose OWN preferred currency is dollars. */
function counterpartiesPreferringUsd(): { customerId: string; supplierId: string } {
  const entities = useEntityStore.getState().entities;
  const customer = entities.find((e) => e.entityType === 'customer' || e.entityType === 'both');
  const supplier = entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both');
  useEntityStore.setState({
    entities: entities.map((e) =>
      e.id === customer?.id || e.id === supplier?.id ? { ...e, defaultCurrency: 'USD' } : e,
    ),
  });
  return { customerId: customer!.id, supplierId: supplier!.id };
}

beforeEach(() => {
  useJournalStore.getState().replaceAll([]);
  companyKeepsBooksIn('JOD');
});

/* ══ The accessor ══════════════════════════════════════════════════════════ */

describe('the canonical accessor', () => {
  it('reports the company currency, with its display name and minor units', () => {
    expect(transactionCurrencyCode()).toBe('JOD');
    const described = describeCurrency('JOD');
    expect(described.label).toBe('JOD — Jordanian Dinar');
    // JOD has THREE minor units, not two.
    expect(described.decimalPlaces).toBe(3);
  });

  it('resolves each organization’s own currency as the active one changes', () => {
    // Switching between organizations must resolve each one's own currency.
    for (const code of ['JOD', 'EUR', 'KWD', 'USD']) {
      companyKeepsBooksIn(code);
      expect(transactionCurrencyCode()).toBe(code);
    }
  });

  it('states that an ordinary transaction is never converted', () => {
    expect(ORDINARY_TRANSACTION_EXCHANGE_RATE).toBe(1);
  });
});

/* ══ Every transaction type ════════════════════════════════════════════════ */

describe('every ordinary transaction takes the company currency', () => {
  it('a general journal entry does, at par', () => {
    const created = useJournalStore.getState().addEntry({
      entryNumber: '', entryDate: '2026-08-01', reference: '', description: 'Test',
      // A payload asking for dollars — as a tampered form submission would.
      currency: 'USD', exchangeRate: 0.709,
      notes: '', transactionType: '', createdBy: 'x', approvedBy: '',
      lines: [],
    });
    const entry = useJournalStore.getState().entries.find((e) => e.id === created.id)!;
    expect(entry.currency).toBe('JOD');
    expect(entry.exchangeRate).toBe(1);
  });

  it('an invoice does, ignoring the customer’s preferred currency', () => {
    const { customerId } = counterpartiesPreferringUsd();
    const created = useInvoiceStore.getState().createDraft({ customerId });
    const invoice = useInvoiceStore.getState().getInvoice(created.id!)!;
    expect(invoice.currency).toBe('JOD');
    expect(invoice.exchangeRate).toBe(1);
  });

  it('a bill does, ignoring the supplier’s preferred currency', () => {
    const { supplierId } = counterpartiesPreferringUsd();
    const created = useBillStore.getState().createDraft({ supplierId });
    const bill = useBillStore.getState().getBill(created.id!)!;
    expect(bill.currency).toBe('JOD');
    expect(bill.exchangeRate).toBe(1);
  });

  it('a payment does', () => {
    const { supplierId } = counterpartiesPreferringUsd();
    const created = usePaymentStore.getState().createDraft({
      paymentType: 'supplier-payment', supplierId, grossAmount: 100,
    });
    expect(usePaymentStore.getState().getPayment(created.id!)!.currency).toBe('JOD');
  });

  it('a receipt does', () => {
    const { customerId } = counterpartiesPreferringUsd();
    const created = useReceiptStore.getState().createDraft({
      receiptType: 'customer-payment', customerId, amount: 100,
    });
    expect(useReceiptStore.getState().getReceiptById(created.id!)!.currency).toBe('JOD');
  });

  it('follows the company when the company currency differs', () => {
    // The same paths, for a euro company — nothing is hard-coded to JOD either.
    companyKeepsBooksIn('EUR');
    const { customerId, supplierId } = counterpartiesPreferringUsd();
    expect(
      useInvoiceStore.getState().getInvoice(
        useInvoiceStore.getState().createDraft({ customerId }).id!,
      )!.currency,
    ).toBe('EUR');
    expect(
      useBillStore.getState().getBill(
        useBillStore.getState().createDraft({ supplierId }).id!,
      )!.currency,
    ).toBe('EUR');
  });
});

/* ══ No drift after creation ═══════════════════════════════════════════════ */

describe('the currency cannot drift after creation', () => {
  it('survives an edit that asks for a different one', () => {
    const created = useJournalStore.getState().addEntry({
      entryNumber: '', entryDate: '2026-08-01', reference: '', description: 'Test',
      currency: 'JOD', exchangeRate: 1,
      notes: '', transactionType: '', createdBy: 'x', approvedBy: '',
      lines: [],
    });

    useJournalStore.getState().updateEntry(created.id!, {
      entryNumber: '', entryDate: '2026-08-01', reference: '', description: 'Edited',
      // The tampered payload again, this time on the way through an edit.
      currency: 'USD', exchangeRate: 0.709,
      notes: '', transactionType: '', createdBy: 'x', approvedBy: '',
      lines: [],
    });

    const entry = useJournalStore.getState().entries.find((e) => e.id === created.id)!;
    expect(entry.description).toBe('Edited');
    expect(entry.currency).toBe('JOD');
    expect(entry.exchangeRate).toBe(1);
  });

  it('does not restate an existing entry when the company currency changes', () => {
    /*
     * The protection that matters most. Changing the company's functional
     * currency must not silently re-denominate records that are already
     * written — that is a restatement, not a settings change.
     */
    const created = useJournalStore.getState().addEntry({
      entryNumber: '', entryDate: '2026-08-01', reference: '', description: 'Before',
      currency: 'JOD', exchangeRate: 1,
      notes: '', transactionType: '', createdBy: 'x', approvedBy: '',
      lines: [],
    });

    companyKeepsBooksIn('EUR');

    const entry = useJournalStore.getState().entries.find((e) => e.id === created.id)!;
    expect(entry.currency).toBe('JOD');

    // An unrelated edit does not convert it either.
    useJournalStore.getState().updateEntry(created.id!, {
      entryNumber: '', entryDate: '2026-08-01', reference: '', description: 'After',
      currency: 'EUR', exchangeRate: 1,
      notes: '', transactionType: '', createdBy: 'x', approvedBy: '',
      lines: [],
    });
    expect(
      useJournalStore.getState().entries.find((e) => e.id === created.id)!.currency,
    ).toBe('JOD');
  });
});

/* ══ The multi-currency module is still there ══════════════════════════════ */

describe('foreign currency remains possible as a deliberate capability', () => {
  it('a source-document posting carries its own denomination', () => {
    /*
     * Section 7 of the policy: the currency catalogue and the exchange-rate
     * infrastructure stay. What has gone is the unrestricted per-transaction
     * dropdown. A journal generated FROM a document must mirror that document,
     * so the capability is an explicit, named opt-in rather than a field
     * anybody can fill in.
     */
    const created = useJournalStore.getState().addEntry({
      entryNumber: '', entryDate: '2026-08-01', reference: '', description: 'From an invoice',
      currency: 'USD', exchangeRate: 0.709,
      notes: '', transactionType: '', createdBy: 'x', approvedBy: '',
      lines: [],
    }, { inheritCurrency: true });

    const entry = useJournalStore.getState().entries.find((e) => e.id === created.id)!;
    expect(entry.currency).toBe('USD');
    expect(entry.exchangeRate).toBe(0.709);
  });

  it('the full ISO catalogue is still available for choosing one', async () => {
    // Needed to select the COMPANY's functional currency, for exchange rates,
    // and for historical imports. Removing it was never the point.
    const { STANDARD_CURRENCY_CATALOG } = await import('@/data/currencyCatalog');
    expect(STANDARD_CURRENCY_CATALOG.length).toBeGreaterThan(150);
    expect(STANDARD_CURRENCY_CATALOG.some((c) => c.code === 'JOD')).toBe(true);
    expect(STANDARD_CURRENCY_CATALOG.some((c) => c.code === 'USD')).toBe(true);
  });
});
