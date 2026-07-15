import { describe, it, expect } from 'vitest';
import { SEED_JOURNAL_ENTRIES, buildSeedJournalEntries } from './journalSeed';
import { SEED_ACCOUNTS } from './seedAccounts';
import { SEED_ENTITIES } from './seedEntities';
import { buildAccountLedger } from '@/lib/generalLedgerCalculations';

const REFS = ['CAP-001', 'RENT-0726', 'INV-1001', 'RCP-1001', 'BILL-2001', 'PAY-2001', 'FA-0001', 'PAYROLL-0726', 'DEP-0726', 'BANK-0726'];
const WIDE = { from: '0000-01-01', to: '9999-12-31' };
const acctByCode = (code: string) => SEED_ACCOUNTS.find((a) => a.code === code)!;
const entById = new Map(SEED_ENTITIES.map((e) => [e.id, e]));
const ledger = (code: string) => buildAccountLedger(acctByCode(code), SEED_JOURNAL_ENTRIES, WIDE, 'USD');
const byRef = (ref: string) => SEED_JOURNAL_ENTRIES.find((e) => e.reference === ref)!;
const isCustomer = (id: string) => { const e = entById.get(id); return !!e && (e.entityType === 'customer' || e.entityType === 'both'); };
const isSupplier = (id: string) => { const e = entById.get(id); return !!e && (e.entityType === 'supplier' || e.entityType === 'both'); };

describe('demo seed — structure', () => {
  it('contains exactly the 10 references, each once', () => {
    expect(SEED_JOURNAL_ENTRIES).toHaveLength(10);
    for (const ref of REFS) {
      expect(SEED_JOURNAL_ENTRIES.filter((e) => e.reference === ref)).toHaveLength(1);
    }
  });
  it('does not duplicate on rebuild (stable references & numbers)', () => {
    const a = buildSeedJournalEntries();
    const b = buildSeedJournalEntries();
    expect(a.map((e) => e.reference)).toEqual(b.map((e) => e.reference));
    expect(new Set(a.map((e) => e.entryNumber)).size).toBe(10);
    expect(new Set(a.map((e) => e.reference)).size).toBe(10);
  });
  it('every entry balances exactly', () => {
    for (const e of SEED_JOURNAL_ENTRIES) {
      expect(e.totalDebit).toBe(e.totalCredit);
      expect(Math.abs(e.difference)).toBeLessThan(0.005);
    }
  });
  it('has 9 posted and 1 draft', () => {
    expect(SEED_JOURNAL_ENTRIES.filter((e) => e.status === 'posted')).toHaveLength(9);
    expect(SEED_JOURNAL_ENTRIES.filter((e) => e.status === 'draft')).toHaveLength(1);
    expect(byRef('BANK-0726').status).toBe('draft');
  });
});

describe('demo seed — general ledger reconciliation (posted only)', () => {
  it('excludes the draft bank charge from the ledger', () => {
    const bank = ledger('1252');
    expect(bank.lines.every((l) => l.journalNumber !== 'JE-0010')).toBe(true);
  });
  it('bank net movement = 223,500.00 (draft 175 excluded)', () => {
    expect(ledger('1252').netMovement).toBe(223500);
    expect(ledger('1252').closingBalance).toBe(223500); // opening 0 → Dr
  });
  it('Trade Receivables closing = 15,000.00 Dr', () => {
    expect(ledger('1221').closingBalance).toBe(15000);
  });
  it('Trade Payables closing = 0.00', () => {
    expect(ledger('2210').closingBalance).toBe(0);
  });
  it('office equipment net carrying amount = 28,750.00', () => {
    const equipment = ledger('1114').closingBalance; // 30,000 Dr
    const accumDep = ledger('1119').closingBalance; // 1,250 Cr (credit-normal, +1250)
    expect(equipment).toBe(30000);
    expect(accumDep).toBe(1250);
    expect(equipment - accumDep).toBe(28750);
  });
});

describe('demo seed — entity linkage', () => {
  it('customer receivable lines reference an existing customer', () => {
    for (const ref of ['INV-1001', 'RCP-1001']) {
      const line = byRef(ref).lines.find((l) => l.accountCode === '1221')!;
      expect(line.entityId).not.toBe('');
      expect(isCustomer(line.entityId)).toBe(true);
    }
  });
  it('supplier lines reference an existing supplier', () => {
    const cases: [string, string][] = [
      ['BILL-2001', '2210'],
      ['PAY-2001', '2210'],
      ['FA-0001', '1114'],
      ['RENT-0726', '6200'],
    ];
    for (const [ref, code] of cases) {
      const line = byRef(ref).lines.find((l) => l.accountCode === code)!;
      expect(line.entityId).not.toBe('');
      expect(isSupplier(line.entityId)).toBe(true);
    }
  });
});
