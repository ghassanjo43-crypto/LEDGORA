// @vitest-environment happy-dom
/**
 * Every transaction form uses the company's monetary precision.
 *
 * ══ Why the forms are checked separately from the resolver ═══════════════════
 *
 * `monetaryPrecision.test.ts` proves the chain resolves correctly and that the
 * shared formatters follow it. That is necessary and not sufficient: a form can
 * still hard-code `step="0.01"` or a `0.00` placeholder of its own, and then a
 * JOD company is offered a field that cannot express a fils however correct the
 * library underneath it is.
 *
 * So these render the real editors and inspect the actual monetary inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useReceiptStore } from '@/store/receiptStore';
import { JournalEntryDrawer } from '@/components/journal/JournalEntryDrawer';
import { InvoiceEditorDrawer } from '@/components/invoices/InvoiceEditorDrawer';
import { BillEditorDrawer } from '@/components/bills/BillEditorDrawer';
import { PaymentEditorDrawer } from '@/components/payments/PaymentEditorDrawer';
import { ReceiptEditorDrawer } from '@/components/receipts/ReceiptEditorDrawer';

function companyKeepsBooksIn(code: string): void {
  useStore.setState((s) => ({ settings: { ...s.settings, baseCurrency: code } }));
}

const page = (node: React.ReactElement) => render(<ToastProvider>{node}</ToastProvider>);

/**
 * The `step` of every MONETARY input on screen.
 *
 * Selected by `data-money`, not by guessing from the step value: a quantity
 * field and a dollar field both read `0.01`, so inferring the classification
 * from the number would make this suite unable to tell a correct USD form from
 * a form that had simply never been updated.
 */
function monetarySteps(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[data-money="true"]'))
    .map((i) => i.getAttribute('step') ?? '');
}

beforeEach(async () => {
  useJournalStore.getState().replaceAll([]);
  useInvoiceStore.setState({ invoices: [] });
  useBillStore.setState({ bills: [] });
  usePaymentStore.setState({ payments: [] });
  useReceiptStore.setState({ receipts: [] });
});
afterEach(cleanup);

/* ══ 13 · General Journal ══════════════════════════════════════════════════ */

describe('the General Journal drawer', () => {
  it('offers thousandths to a JOD company', async () => {
    companyKeepsBooksIn('JOD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);

    const debit = document.querySelector<HTMLInputElement>('[data-col="debit"]')!;
    expect(debit.getAttribute('step')).toBe('0.001');
    expect(debit.getAttribute('placeholder')).toBe('0.000');
  });

  it('offers hundredths to a USD company', async () => {
    companyKeepsBooksIn('USD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);

    const debit = document.querySelector<HTMLInputElement>('[data-col="debit"]')!;
    expect(debit.getAttribute('step')).toBe('0.01');
    expect(debit.getAttribute('placeholder')).toBe('0.00');
  });

  it('offers whole units to a JPY company', async () => {
    companyKeepsBooksIn('JPY');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);

    const debit = document.querySelector<HTMLInputElement>('[data-col="debit"]')!;
    expect(debit.getAttribute('step')).toBe('1');
    expect(debit.getAttribute('placeholder')).toBe('0');
  });

  it('applies the same precision to the credit and tax-amount fields', async () => {
    companyKeepsBooksIn('JOD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);

    expect(document.querySelector('[data-col="credit"]')!.getAttribute('step')).toBe('0.001');
    const tax = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .find((i) => i.placeholder === 'Tax amt');
    expect(tax!.getAttribute('step')).toBe('0.001');
  });
});

/* ══ 15, 17, 18, 19 · Documents ════════════════════════════════════════════ */

describe('the document editors', () => {
  /** Open each editor on a freshly created draft of its own kind. */
  const editors = [
    ['Invoice', async () => {
      const id = (await useInvoiceStore.getState().createDraft({})).id!;
      return <InvoiceEditorDrawer open invoiceId={id} onClose={() => {}} />;
    }],
    ['Bill', () => {
      const id = (useBillStore.getState().createDraft()).id!;
      return <BillEditorDrawer open billId={id} onClose={() => {}} />;
    }],
    ['Payment', () => {
      const id = (usePaymentStore.getState().createDraft()).id!;
      return <PaymentEditorDrawer open paymentId={id} onClose={() => {}} />;
    }],
    ['Receipt', () => {
      const id = (useReceiptStore.getState().createDraft()).id!;
      return <ReceiptEditorDrawer open receiptId={id} onClose={() => {}} />;
    }],
  ] as const;

  it.each(editors)('%s uses thousandths for a JOD company', async (_label, open) => {
    companyKeepsBooksIn('JOD');
    page(await open());
    const steps = monetarySteps();
    expect(steps.length).toBeGreaterThan(0);
    // Every monetary field follows the currency; none is left at a hard 0.01.
    expect(steps.every((s) => s === '0.001')).toBe(true);
  });

  it.each(editors)('%s uses hundredths for a USD company', async (_label, open) => {
    companyKeepsBooksIn('USD');
    page(await open());
    const steps = monetarySteps();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s === '0.01')).toBe(true);
  });

  it.each(editors)('%s uses whole units for a JPY company', async (_label, open) => {
    companyKeepsBooksIn('JPY');
    page(await open());
    const steps = monetarySteps();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s === '1')).toBe(true);
  });
});

/* ══ 25–26 · Switching companies mid-session ═══════════════════════════════ */

describe('switching companies', () => {
  it('re-resolves the journal precision without a reload', async () => {
    companyKeepsBooksIn('JOD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);
    expect(document.querySelector('[data-col="debit"]')!.getAttribute('step')).toBe('0.001');

    cleanup();
    companyKeepsBooksIn('USD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);
    expect(document.querySelector('[data-col="debit"]')!.getAttribute('step')).toBe('0.01');

    cleanup();
    companyKeepsBooksIn('JOD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);
    expect(document.querySelector('[data-col="debit"]')!.getAttribute('step')).toBe('0.001');
  });

  it('shows the company currency beside the amounts', async () => {
    // The label and the precision must agree: "(JOD)" over a 2-decimal field
    // would be worse than either mistake alone.
    companyKeepsBooksIn('JOD');
    page(<JournalEntryDrawer open mode={{ kind: 'create' }} onClose={() => {}} />);
    expect(screen.getByTestId('journal-currency').textContent).toContain('JOD');
    expect(document.querySelector('[data-col="debit"]')!.getAttribute('step')).toBe('0.001');
  });
});

/* ══ 31 · Percentages and quantities are untouched ═════════════════════════ */

describe('non-monetary fields keep their own precision', () => {
  it('leaves quantity and rate fields alone in a JOD company', async () => {
    /*
     * A JOD bill still counts whole widgets and charges a 16% tax rate. Only
     * the money follows the currency — sweeping every numeric input into
     * thousandths would be the same class of mistake in the other direction.
     */
    companyKeepsBooksIn('JOD');
    const id = (useBillStore.getState().createDraft()).id!;
    page(<BillEditorDrawer open billId={id} onClose={() => {}} />);

    const all = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    const monetary = all.filter((i) => i.dataset.money === 'true');
    const nonMonetary = all.filter((i) => i.dataset.money !== 'true');
    expect(monetary.length).toBeGreaterThan(0);
    expect(monetary.every((i) => i.getAttribute('step') === '0.001')).toBe(true);
    // Quantity, discount %, tax rate and withholding rate stay at 0.01.
    expect(nonMonetary.length).toBeGreaterThan(0);
    expect(nonMonetary.every((i) => i.getAttribute('step') !== '0.001')).toBe(true);
  });
});
