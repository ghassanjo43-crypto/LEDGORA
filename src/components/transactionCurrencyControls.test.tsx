// @vitest-environment happy-dom
/**
 * No transactional form offers a currency choice.
 *
 * ══ Why this is a source scan and not only a render test ═════════════════════
 *
 * Rendering every editor would need each one's full store fixture — a supplier,
 * a customer, a template, an open document — and the thing under test is not
 * how any single drawer behaves. It is a property of the WHOLE set of
 * transactional editors: that none of them contains an enabled currency
 * control, including the ones a future change might add one back to.
 *
 * So this reads the source of every transaction editor and asserts the absence
 * directly. It is a tripwire, and it is meant to fail the day somebody
 * reintroduces a `<CurrencyPicker>` or an editable exchange-rate input into one
 * of these files — which a render test of the four editors that happen to have
 * fixtures today would not catch.
 *
 * `journalDraftState.test.tsx` complements this by rendering the General
 * Journal drawer for real and finding no control in the DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Every editor a user records an ordinary accounting transaction in. */
const TRANSACTION_EDITORS = [
  'src/components/journal/JournalEntryDrawer.tsx',
  'src/pages/journalVouchers/JournalVouchersPage.tsx',
  'src/components/invoices/InvoiceEditorDrawer.tsx',
  'src/components/credit-notes/CreditNoteEditorDrawer.tsx',
  'src/components/bills/BillEditorDrawer.tsx',
  'src/components/payments/PaymentEditorDrawer.tsx',
  'src/components/receipts/ReceiptEditorDrawer.tsx',
];

/**
 * Where a currency choice is still CORRECT.
 *
 * Choosing the company's own functional currency is exactly what the catalogue
 * is for, and section 7 of the policy is explicit that it stays. These are the
 * files allowed to contain a picker.
 */
const LEGITIMATE_CURRENCY_CHOOSERS = [
  'src/components/company/AddCompanyDialog.tsx',
  'src/components/settings/SettingsPanel.tsx',
  'src/components/admin/CreateSubscriberDrawer.tsx',
  'src/pages/onboarding/OnboardingOrganizationPage.tsx',
  'src/pages/CurrenciesPage.tsx',
  'src/pages/ExchangeRatesPage.tsx',
];

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('transactional forms expose no currency choice', () => {
  it.each(TRANSACTION_EDITORS)('%s has no currency picker', (path) => {
    const source = read(path);
    expect(source).not.toMatch(/<CurrencyPicker/);
    expect(source).not.toMatch(/<CurrencySelector/);
  });

  it.each(TRANSACTION_EDITORS)('%s has no editable currency field', (path) => {
    const source = read(path);
    // An `<Input>` bound to a currency setter — the Bill form's old free-text
    // code field, which accepted any three letters typed into it.
    expect(source).not.toMatch(/setCurrency\(/);
    expect(source).not.toMatch(/currency:\s*e\.target\.value/);
  });

  it.each(TRANSACTION_EDITORS)('%s has no editable exchange rate', (path) => {
    const source = read(path);
    expect(source).not.toMatch(/setExchangeRate\(/);
    expect(source).not.toMatch(/exchangeRate:\s*Number\(e\.target\.value\)/);
  });

  it('states the currency read-only wherever a transaction is recorded', () => {
    // Removing the control must not mean removing the information: the user
    // still needs to see which currency the amounts are in.
    for (const path of TRANSACTION_EDITORS) {
      expect(read(path), path).toMatch(/ReadOnlyValue/);
    }
  });

  it('reads the value from the canonical accessor, not a local default', () => {
    // The `?? 'USD'` fallbacks are what put dollar invoices in a JOD company's
    // books. Nothing in a transaction editor may carry one.
    for (const path of TRANSACTION_EDITORS) {
      const source = read(path);
      expect(source, path).not.toMatch(/currency\s*[?][?]\s*'USD'/);
      expect(source, path).toMatch(/from '@\/lib\/transactionCurrency'/);
    }
  });
});

describe('the currency catalogue is still reachable where it should be', () => {
  it('company setup and the currency module keep their pickers', () => {
    // Proves the policy removed a per-transaction CHOICE, not the ability to
    // choose a company's functional currency at all.
    const withPickers = LEGITIMATE_CURRENCY_CHOOSERS.filter((path) =>
      /<CurrencyPicker|<CurrencySelector/.test(read(path)),
    );
    expect(withPickers.length).toBeGreaterThanOrEqual(4);
  });
});
