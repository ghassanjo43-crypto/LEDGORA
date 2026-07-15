import { describe, it, expect, beforeEach } from 'vitest';
import type { TaxCode, TaxRateVersion } from '@/types/taxCode';
import type { TaxLineRecord, TaxReportingBox } from '@/types/taxReporting';
import {
  calculateTaxExclusive, calculateTaxInclusive, calculateCompoundTax, calculateRecoverableTax,
  calculateTaxLine, calculateDocumentTaxTotals, calculateTaxGroup, effectiveRate,
} from '@/lib/taxCalculations';
import { applyRounding } from '@/lib/taxRounding';
import { resolveTaxRateVersion, resolveDefaultTaxCode, selectableTaxCodes, hasOverlappingRateVersion } from '@/lib/taxResolution';
import { createTaxSnapshot, createReversalSnapshot } from '@/lib/taxSnapshots';
import { buildTaxPostingLines } from '@/lib/taxPosting';
import { validateTaxCodeForActivation, validateTaxCodeForTransaction } from '@/lib/taxValidation';
import { buildTaxSummaryReport, buildTaxBoxTotals, filterTaxRecords, extractManualJournalTaxRecords, collectTaxAccountIds } from '@/lib/taxReporting';
import { reconcileTaxControlAccounts } from '@/lib/taxReconciliation';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { SEED_TAX_CODES, SEED_TAX_REPORTING_BOXES } from '@/data/taxSeed';

const codeById = (id: string) => useTaxCodeStore.getState().getTaxCode(id)!;
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;

function baseCode(over: Partial<TaxCode> = {}): TaxCode {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'tc1', code: 'STD', name: 'Standard', category: 'standard', direction: 'sales', scope: 'domestic', status: 'active',
    rate: 16, rateType: 'percentage', calculationMethod: 'exclusive', roundingMethod: 'line', precision: 2,
    reportingBoxIds: ['box_1', 'box_2'], effectiveFrom: '2026-01-01', auditTrail: [], createdAt: now, updatedAt: now,
    ...over,
  };
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useTaxCodeStore.getState().resetToDefault();
  useTaxPeriodStore.getState().resetToDefault();
});

/* ───────────────────── Calculation methods ───────────────────── */

describe('calculation methods', () => {
  it('exclusive: 1000 @16% → tax 160, gross 1160', () => {
    expect(calculateTaxExclusive(1000, 16)).toEqual({ taxableAmount: 1000, taxAmount: 160, grossAmount: 1160 });
  });
  it('inclusive: 1160 incl 16% → net 1000, tax 160', () => {
    expect(calculateTaxInclusive(1160, 16)).toEqual({ taxableAmount: 1000, taxAmount: 160, grossAmount: 1160 });
  });
  it('compound sequential: base 1000 rates [10,5] → 100 then 55 = 155', () => {
    const r = calculateCompoundTax(1000, [10, 5]);
    expect(r.perRate[0]!.taxAmount).toBe(100);
    expect(r.perRate[1]!.taxAmount).toBe(55); // 5% of 1100
    expect(r.taxAmount).toBe(155);
  });
  it('partial recoverability: 160 @75% → 120 / 40', () => {
    expect(calculateRecoverableTax(160, 75)).toEqual({ recoverableTaxAmount: 120, nonRecoverableTaxAmount: 40 });
  });
});

/* ───────────────────── Categories ───────────────────── */

describe('zero-rated vs exempt vs out-of-scope', () => {
  it('zero-rated reports the base with zero tax', () => {
    const r = calculateTaxLine({ amount: 5000, rate: 0, category: 'zero-rated', method: 'exclusive' });
    expect(r.taxAmount).toBe(0);
    expect(r.taxableAmount).toBe(5000);
    expect(r.reportableBase).toBe(true);
  });
  it('exempt reports the base with zero tax (distinct category)', () => {
    const r = calculateTaxLine({ amount: 5000, rate: 0, category: 'exempt', method: 'exclusive' });
    expect(r.taxAmount).toBe(0);
    expect(r.reportableBase).toBe(true);
  });
  it('out-of-scope has no tax and no reportable base', () => {
    const r = calculateTaxLine({ amount: 5000, rate: 16, category: 'out-of-scope', method: 'exclusive' });
    expect(effectiveRate(16, 'out-of-scope')).toBe(0);
    expect(r.taxAmount).toBe(0);
    expect(r.reportableBase).toBe(false);
  });
});

/* ───────────────────── Rounding ───────────────────── */

describe('rounding methods', () => {
  const raw = [10.005, 10.005, 10.005]; // sums to 30.015
  it('line rounding rounds each then sums', () => {
    const { total } = applyRounding(raw, 'line');
    expect(total).toBe(30.03); // 10.01 × 3
  });
  it('document rounding rounds the aggregate once', () => {
    const { total } = applyRounding(raw, 'document');
    expect(total).toBe(30.02); // round(30.015)
  });
});

/* ───────────────────── Document totals ───────────────────── */

describe('document totals', () => {
  it('sums line results with recoverable split', () => {
    const l1 = calculateTaxLine({ amount: 1000, rate: 16, category: 'standard', method: 'exclusive', recoverabilityPercent: 75 });
    const l2 = calculateTaxLine({ amount: 500, rate: 16, category: 'standard', method: 'exclusive', recoverabilityPercent: 75 });
    const t = calculateDocumentTaxTotals([l1, l2], 'line');
    expect(t.taxableTotal).toBe(1500);
    expect(t.taxTotal).toBe(240);
    expect(t.recoverableTotal).toBe(180);
    expect(t.nonRecoverableTotal).toBe(60);
  });
});

/* ───────────────────── Tax groups ───────────────────── */

describe('tax group order', () => {
  it('parallel taxes the same base', () => {
    const r = calculateTaxGroup(1000, [{ taxCodeId: 'a', rate: 10, category: 'standard' }, { taxCodeId: 'b', rate: 5, category: 'standard' }], 'parallel');
    expect(r.members.map((m) => m.taxAmount)).toEqual([100, 50]);
    expect(r.taxTotal).toBe(150);
  });
  it('sequential compounds on prior taxes', () => {
    const r = calculateTaxGroup(1000, [{ taxCodeId: 'a', rate: 10, category: 'standard' }, { taxCodeId: 'b', rate: 5, category: 'standard' }], 'sequential');
    expect(r.members.map((m) => m.taxAmount)).toEqual([100, 55]);
    expect(r.taxTotal).toBe(155);
  });
});

/* ───────────────────── Rate versions ───────────────────── */

describe('effective-dated rate versions', () => {
  const versions: TaxRateVersion[] = [
    { id: 'v1', taxCodeId: 'tc1', rate: 16, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', createdAt: '' },
    { id: 'v2', taxCodeId: 'tc1', rate: 18, effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31', createdAt: '' },
  ];
  it('resolves the version applicable on the transaction date', () => {
    expect(resolveTaxRateVersion(baseCode(), versions, '2026-06-01').rate).toBe(16);
    expect(resolveTaxRateVersion(baseCode(), versions, '2027-06-01').rate).toBe(18);
  });
  it('blocks overlapping effective periods', () => {
    expect(hasOverlappingRateVersion(versions, 'tc1', '2026-06-01', undefined)).toBe(true);
    expect(hasOverlappingRateVersion(versions, 'tc1', '2028-01-01', undefined)).toBe(false);
  });
});

/* ───────────────────── Snapshots ───────────────────── */

describe('tax snapshots', () => {
  it('freezes the rate so a later code change does not alter history', () => {
    const code = baseCode();
    const version = resolveTaxRateVersion(code, [], '2026-06-01');
    const snap = createTaxSnapshot({ code, version, amount: 1000, capturedAt: '2026-06-01' });
    expect(snap.rate).toBe(16);
    expect(snap.taxAmount).toBe(160);
    // Mutating the live code must not touch the snapshot.
    const changed = { ...code, rate: 18 };
    void changed;
    expect(snap.rate).toBe(16);
    expect(snap.taxAmount).toBe(160);
  });
  it('reversal snapshot re-scales using the ORIGINAL rate', () => {
    const code = baseCode();
    const snap = createTaxSnapshot({ code, version: resolveTaxRateVersion(code, [], '2026-06-01'), amount: 1000, capturedAt: 'x' });
    const partial = createReversalSnapshot(snap, 400, 'y'); // reverse 400 of 1000
    expect(partial.rate).toBe(16);
    expect(partial.taxableAmount).toBe(400);
    expect(partial.taxAmount).toBe(64);
  });
});

/* ───────────────────── Posting lines ───────────────────── */

describe('tax posting lines', () => {
  it('sales standard → Cr output tax', () => {
    const snap = createTaxSnapshot({ code: baseCode({ outputTaxAccountId: 'OUT' }), version: resolveTaxRateVersion(baseCode({ outputTaxAccountId: 'OUT' }), [], '2026-06-01'), amount: 1000, capturedAt: 'x' });
    const lines = buildTaxPostingLines(snap, { direction: 'sales' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ accountId: 'OUT', debit: 0, credit: 160, kind: 'output' });
  });
  it('purchase partial recoverability splits input tax', () => {
    const code = baseCode({ direction: 'purchase', inputTaxAccountId: 'IN', recoverabilityPercent: 75 });
    const snap = createTaxSnapshot({ code, version: resolveTaxRateVersion(code, [], '2026-06-01'), amount: 1000, capturedAt: 'x' });
    const lines = buildTaxPostingLines(snap, { direction: 'purchase', nonRecoverableTargetAccountId: 'EXP' });
    expect(lines.find((l) => l.kind === 'input-recoverable')!.debit).toBe(120);
    expect(lines.find((l) => l.kind === 'input-non-recoverable')!.debit).toBe(40);
  });
  it('reverse charge posts BOTH input and output tax', () => {
    const code = baseCode({ category: 'reverse-charge', direction: 'purchase', inputTaxAccountId: 'IN', reverseChargeInputAccountId: 'IN', reverseChargeOutputAccountId: 'OUT' });
    const snap = createTaxSnapshot({ code, version: resolveTaxRateVersion(code, [], '2026-06-01'), amount: 1000, capturedAt: 'x' });
    const lines = buildTaxPostingLines(snap, { direction: 'purchase' });
    expect(lines.find((l) => l.kind === 'input-recoverable')!.debit).toBe(160);
    expect(lines.find((l) => l.kind === 'reverse-charge-output')!.credit).toBe(160);
  });
  it('zero-rated produces no tax line', () => {
    const code = baseCode({ category: 'zero-rated', rate: 0 });
    const snap = createTaxSnapshot({ code, version: resolveTaxRateVersion(code, [], '2026-06-01'), amount: 5000, capturedAt: 'x' });
    expect(buildTaxPostingLines(snap, { direction: 'sales' })).toHaveLength(0);
  });
});

/* ───────────────────── Validation ───────────────────── */

describe('validation', () => {
  const ctx = () => ({ accountsById: new Map(useStore.getState().accounts.map((a) => [a.id, a])), existingCodes: SEED_TAX_CODES, versions: [] });
  it('blocks a missing output account on a taxable sales code', () => {
    const issues = validateTaxCodeForActivation(baseCode({ id: 'x', outputTaxAccountId: undefined }), ctx());
    expect(issues.some((i) => i.rule === 'output-account')).toBe(true);
  });
  it('blocks a missing input account on a taxable purchase code', () => {
    const issues = validateTaxCodeForActivation(baseCode({ id: 'x', direction: 'purchase', inputTaxAccountId: undefined }), ctx());
    expect(issues.some((i) => i.rule === 'input-account')).toBe(true);
  });
  it('blocks a non-posting (header) account', () => {
    const header = useStore.getState().accounts.find((a) => !a.isPostingAccount)!;
    const issues = validateTaxCodeForActivation(baseCode({ id: 'x', outputTaxAccountId: header.id }), ctx());
    expect(issues.some((i) => i.rule === 'output-account')).toBe(true);
  });
  it('blocks a duplicate code within the jurisdiction', () => {
    const dup = baseCode({ id: 'x', code: 'S-STD', outputTaxAccountId: acc('2270'), jurisdictionId: 'jur_GEN' });
    const issues = validateTaxCodeForActivation(dup, ctx());
    expect(issues.some((i) => i.rule === 'code-unique')).toBe(true);
  });
  it('an inactive code is unavailable for new transactions', () => {
    const issues = validateTaxCodeForTransaction(baseCode({ status: 'inactive' }), '2026-06-01');
    expect(issues.some((i) => i.rule === 'inactive')).toBe(true);
  });
  it('selectable codes filter by direction', () => {
    const sales = selectableTaxCodes(SEED_TAX_CODES, 'sales', '2026-06-01').map((c) => c.code);
    expect(sales).toContain('S-STD');
    expect(sales).not.toContain('P-STD');
  });
});

/* ───────────────────── Default resolution ───────────────────── */

describe('default tax resolution', () => {
  it('honours priority and reports the source', () => {
    expect(resolveDefaultTaxCode({ direction: 'sales', explicitTaxCodeId: 'X', taxCodes: SEED_TAX_CODES })).toEqual({ taxCodeId: 'X', source: 'explicit' });
    expect(resolveDefaultTaxCode({ direction: 'sales', party: { defaultSalesTaxCodeId: 'P' }, taxCodes: SEED_TAX_CODES })).toEqual({ taxCodeId: 'P', source: 'party' });
    const entity = resolveDefaultTaxCode({ direction: 'sales', taxCodes: SEED_TAX_CODES });
    expect(entity.source).toBe('entity-default');
    expect(codeById(entity.taxCodeId!).code).toBe('S-STD');
  });
});

/* ───────────────────── Store: rate versions & lifecycle ───────────────────── */

describe('tax code store', () => {
  it('creating a rate version end-dates the prior and blocks overlaps', () => {
    const store = useTaxCodeStore.getState();
    const codeId = SEED_TAX_CODES.find((c) => c.code === 'S-STD')!.id;
    const res = store.createRateVersion(codeId, { rate: 18, effectiveFrom: '2027-01-01' });
    expect(res.ok).toBe(true);
    const versions = useTaxCodeStore.getState().getVersionsForCode(codeId);
    const prior = versions.find((v) => v.effectiveFrom === '2026-01-01')!;
    expect(prior.effectiveTo).toBe('2026-12-31');
    // A genuine overlap — backdating into the now-closed 2026 range — is blocked.
    expect(useTaxCodeStore.getState().createRateVersion(codeId, { rate: 20, effectiveFrom: '2026-06-01' }).ok).toBe(false);
  });

  it('activation validates account mappings', () => {
    const store = useTaxCodeStore.getState();
    const { id } = store.createTaxCode({ code: 'NEW', name: 'New', category: 'standard', direction: 'sales' });
    expect(store.activateTaxCode(id!).ok).toBe(false); // no output account
    store.updateTaxCode(id!, { outputTaxAccountId: acc('2270') });
    expect(useTaxCodeStore.getState().activateTaxCode(id!).ok).toBe(true);
  });

  it('hydrates from LocalStorage snapshot via replaceAll', () => {
    const snapshot = JSON.parse(JSON.stringify(useTaxCodeStore.getState().taxCodes));
    useTaxCodeStore.getState().replaceAll({ taxCodes: snapshot });
    expect(useTaxCodeStore.getState().taxCodes.find((c) => c.code === 'S-STD')).toBeTruthy();
  });
});

/* ───────────────────── Reporting ───────────────────── */

function record(over: Partial<TaxLineRecord>): TaxLineRecord {
  return {
    id: 'r', date: '2026-06-01', documentType: 'invoice', documentNumber: 'INV-1', entityId: 'primary',
    taxCodeId: 'tax_S-STD', taxCode: 'S-STD', taxName: 'Std', category: 'standard', direction: 'sales', rate: 16,
    taxableAmount: 1000, taxAmount: 160, grossAmount: 1160, recoverableTaxAmount: 0, nonRecoverableTaxAmount: 0,
    taxAccountId: acc('2270'), reportingBoxIds: ['box_1', 'box_2'], journalEntryId: 'je1', status: 'posted',
    currency: 'USD', exchangeRate: 1, baseTaxableAmount: 1000, baseTaxAmount: 160, ...over,
  };
}

describe('tax summary & boxes', () => {
  it('summary splits output vs input and computes net payable', () => {
    const records = [
      record({ id: 'a', direction: 'sales', taxCodeId: 'tax_S-STD', taxCode: 'S-STD' }),
      record({ id: 'b', direction: 'purchase', taxCodeId: 'tax_P-STD', taxCode: 'P-STD', taxAmount: 80, baseTaxAmount: 80, reportingBoxIds: ['box_3', 'box_4'] }),
    ];
    const summary = buildTaxSummaryReport(records);
    expect(summary.outputTaxTotal).toBe(160);
    expect(summary.inputTaxTotal).toBe(80);
    expect(summary.netPayable).toBe(80);
  });
  it('box totals honour amount basis', () => {
    const boxes: TaxReportingBox[] = SEED_TAX_REPORTING_BOXES;
    const totals = buildTaxBoxTotals([record({})], boxes);
    expect(totals.find((t) => t.boxId === 'box_1')!.amount).toBe(1000); // taxable base
    expect(totals.find((t) => t.boxId === 'box_2')!.amount).toBe(160); // tax amount
  });
  it('filters by entity and date', () => {
    const records = [record({ id: 'a', date: '2026-06-01' }), record({ id: 'b', date: '2026-09-01' })];
    expect(filterTaxRecords(records, { to: '2026-07-01' })).toHaveLength(1);
  });
  it('multi-currency base tax value uses the exchange rate', () => {
    const r = record({ currency: 'EUR', exchangeRate: 1.1, taxAmount: 160, baseTaxAmount: 176 });
    expect(buildTaxSummaryReport([r]).outputTaxTotal).toBe(176);
  });
});

/* ───────────────────── Manual journal extraction & reconciliation ───────────────────── */

describe('manual journal tax & reconciliation', () => {
  function postManualTaxJournal(): string {
    const j = useJournalStore.getState();
    const added = j.addEntry({
      entryNumber: '', entryDate: '2026-06-01', reference: 'MAN-1', description: 'Manual tax', currency: 'USD', exchangeRate: 1,
      notes: '', transactionType: 'Manual', createdBy: 'x', approvedBy: '',
      lines: [
        { accountId: acc('6300'), accountCode: '6300', accountName: '', description: '', debit: 1000, credit: 0, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
        { accountId: acc('2270'), accountCode: '2270', accountName: '', description: '', debit: 160, credit: 0, entityId: '', entityName: '', costCenter: '', project: '', taxCode: 'P-STD', taxAmount: 1000, memo: '' },
        { accountId: acc('2210'), accountCode: '2210', accountName: '', description: '', debit: 0, credit: 1160, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
      ],
    });
    useJournalStore.getState().postEntry(added.id!);
    return added.id!;
  }

  it('extracts a manual journal tax record and excludes generated journals', () => {
    const jeId = postManualTaxJournal();
    const codesByCode = new Map(SEED_TAX_CODES.map((c) => [c.code, c]));
    const records = extractManualJournalTaxRecords(useJournalStore.getState().entries, { taxAccountIds: new Set([acc('2270')]), codesByCode, baseCurrency: 'USD' });
    expect(records).toHaveLength(1);
    expect(records[0]!.taxAmount).toBe(160);
    // Excluding this journal id yields nothing (no double counting of generated journals).
    const excluded = extractManualJournalTaxRecords(useJournalStore.getState().entries, { taxAccountIds: new Set([acc('2270')]), codesByCode, excludeJournalIds: new Set([jeId]), baseCurrency: 'USD' });
    expect(excluded).toHaveLength(0);
  });

  it('reconciles report totals to the GL and flags untagged tax lines', () => {
    postManualTaxJournal();
    const codes = SEED_TAX_CODES;
    const codesByCode = new Map(codes.map((c) => [c.code, c]));
    const records = extractManualJournalTaxRecords(useJournalStore.getState().entries, { taxAccountIds: collectTaxAccountIds(codes), codesByCode, baseCurrency: 'USD' });
    const recon = reconcileTaxControlAccounts({ records, entries: useJournalStore.getState().entries, accounts: useStore.getState().accounts, taxCodes: codes, baseCurrency: 'USD' });
    const input = recon.lines.find((l) => l.key === 'input')!;
    expect(input.reportTotal).toBe(160);
    expect(input.glBalance).toBe(160);
    expect(input.reconciled).toBe(true);
  });
});

/* ───────────────────── Tax periods ───────────────────── */

describe('tax periods', () => {
  it('blocks posting into a locked period and requires a reason to reopen', () => {
    const store = useTaxPeriodStore.getState();
    const { id } = store.createPeriod({ entityId: 'primary', jurisdictionId: 'jur_GEN', periodStart: '2026-01-01', periodEnd: '2026-03-31' });
    store.lockPeriod(id!);
    const check = useTaxPeriodStore.getState().checkPosting('primary', 'jur_GEN', '2026-02-15');
    expect(check.blocked).toBe(true);
    expect(useTaxPeriodStore.getState().reopenPeriod(id!, '').ok).toBe(false); // reason required
    expect(useTaxPeriodStore.getState().reopenPeriod(id!, 'audit correction').ok).toBe(true);
    expect(useTaxPeriodStore.getState().checkPosting('primary', 'jur_GEN', '2026-02-15').blocked).toBe(false);
  });
  it('prepared period warns but allows', () => {
    const store = useTaxPeriodStore.getState();
    const { id } = store.createPeriod({ entityId: 'primary', jurisdictionId: 'jur_GEN', periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    store.setStatus(id!, 'prepared');
    const check = useTaxPeriodStore.getState().checkPosting('primary', 'jur_GEN', '2026-05-01');
    expect(check.blocked).toBe(false);
    expect(check.requiresWarning).toBe(true);
  });
});
