// @vitest-environment happy-dom
/**
 * A durable subscriber's tax codes come from the server, and nowhere else.
 *
 * ══ The failure this guards ══════════════════════════════════════════════════
 *
 * The tempting behaviour when the fetch fails is to fall back to the browser's
 * seeded tax codes so the picker "still works". It would show codes that cannot
 * be used: an invoice line names a tax code by id, the server holds a foreign
 * key to it, and a code that only exists in localStorage is one no invoice can
 * ever be issued against. The user would pick it, save, and be told the code
 * does not exist — about a code on the screen in front of them.
 *
 * So there is no fallback, and these tests pin that along with the rest of the
 * cutover: the verdict, the company-scope clearing, and the late-response guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), history: vi.fn(),
  create: vi.fn(), update: vi.fn(), addRate: vi.fn(), setStatus: vi.fn(),
}));
vi.mock('@/services/api/taxCodesApi', () => ({ taxCodesApi: api }));
/*
 * The other gateways `booksScope` reaches on a company change. Mocked so this
 * file exercises the scope clearing without booting the invoice and accounting
 * stacks behind it.
 */
vi.mock('@/services/api/invoicesApi', () => ({
  invoicesApi: { list: vi.fn(async () => []) },
}));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

import { enterCompanyScope, __resetBooksScopeForTests } from '@/services/books/booksScope';
import { useServerTaxCodeStore, taxCodeBackend, rateOn } from './serverTaxCodeStore';

const code = (over: Record<string, unknown> = {}) => ({
  id: 'tax-1', code: 'VAT16', name: 'Standard-rated sales', description: '',
  category: 'standard', calculationMethod: 'exclusive', status: 'active',
  outputTaxAccountId: 'acct-out', effectiveFrom: '2026-01-01', effectiveTo: null, version: 1,
  rateVersions: [{
    id: 'rv-1', taxCodeId: 'tax-1', rate: '16.000000',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    outputTaxAccountId: 'acct-out', createdAt: '2026-01-01T00:00:00.000Z',
  }],
  ...over,
});

beforeEach(() => {
  engine.current = 'server';
  Object.values(api).forEach((fn) => fn.mockReset());
  api.list.mockResolvedValue([code()]);
  __resetBooksScopeForTests();
  localStorage.clear();
  useServerTaxCodeStore.setState({ taxCodes: [], loading: false, loaded: false, loadError: undefined });
});
afterEach(() => { vi.clearAllMocks(); });

/* ══ The verdict ═══════════════════════════════════════════════════════════ */

describe('which tax configuration a durable subscriber gets', () => {
  it('is the SERVER', () => {
    expect(taxCodeBackend()).toBe('server');
  });

  it('is the browser in a demo workspace, whose codes are the originals', () => {
    engine.current = 'demo';
    expect(taxCodeBackend()).toBe('browser');
  });

  it('asks the server for nothing in a demo workspace', async () => {
    engine.current = 'demo';
    await useServerTaxCodeStore.getState().load();
    expect(api.list).not.toHaveBeenCalled();
    expect(useServerTaxCodeStore.getState().taxCodes).toHaveLength(0);
  });
});

/* ══ No fallback ═══════════════════════════════════════════════════════════ */

describe('when the server cannot be reached', () => {
  it('reports the failure and offers NO codes at all', async () => {
    api.list.mockRejectedValue(new Error('Network unreachable'));

    await useServerTaxCodeStore.getState().load();

    const state = useServerTaxCodeStore.getState();
    expect(state.loadError).toContain('Network unreachable');
    /* Empty, not seeded. A code that only exists here cannot be issued against. */
    expect(state.taxCodes).toHaveLength(0);
  });

  it('writes nothing to browser storage on a successful load either', async () => {
    const before = JSON.stringify(localStorage);
    await useServerTaxCodeStore.getState().load();
    expect(useServerTaxCodeStore.getState().taxCodes).toHaveLength(1);
    expect(JSON.stringify(localStorage)).toBe(before);
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('company scope', () => {
  it('clears cached codes IMMEDIATELY on a company change', async () => {
    await useServerTaxCodeStore.getState().load();
    expect(useServerTaxCodeStore.getState().taxCodes).toHaveLength(1);

    enterCompanyScope('co_other');

    /* Another company's tax codes on this company's invoice would be refused by
     * the server for a code the user can see. */
    expect(useServerTaxCodeStore.getState().taxCodes).toHaveLength(0);
    expect(useServerTaxCodeStore.getState().loaded).toBe(false);
  });

  it('DISCARDS a response that arrives after the company changed', async () => {
    let release: (value: unknown[]) => void = () => {};
    api.list.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = useServerTaxCodeStore.getState().load();
    enterCompanyScope('co_elsewhere');
    release([code({ code: 'PREVIOUS-COMPANY' })]);
    await pending;

    expect(useServerTaxCodeStore.getState().taxCodes).toHaveLength(0);
  });
});

/* ══ Selection ═════════════════════════════════════════════════════════════ */

describe('which codes a line may choose', () => {
  it('offers only codes ACTIVE and effective on the invoice date', async () => {
    api.list.mockResolvedValue([
      code({ id: 'ok', code: 'VAT16' }),
      code({ id: 'archived', code: 'OLD', status: 'archived' }),
      code({ id: 'inactive', code: 'PAUSED', status: 'inactive' }),
      code({ id: 'future', code: 'NEXT', effectiveFrom: '2027-01-01' }),
    ]);
    await useServerTaxCodeStore.getState().load();

    const selectable = useServerTaxCodeStore.getState().selectableOn('2026-06-01');
    expect(selectable.map((c) => c.id)).toEqual(['ok']);
  });

  it('excludes a code with no RATE in force on the date', async () => {
    api.list.mockResolvedValue([code({
      rateVersions: [{
        id: 'rv-1', taxCodeId: 'tax-1', rate: '16.000000',
        effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31',
        outputTaxAccountId: 'acct-out', createdAt: null,
      }],
    })]);
    await useServerTaxCodeStore.getState().load();

    /* Offering it would produce a refusal at save for a code on the screen. */
    expect(useServerTaxCodeStore.getState().selectableOn('2026-06-01')).toHaveLength(0);
    expect(useServerTaxCodeStore.getState().selectableOn('2026-02-01')).toHaveLength(1);
  });

  it('resolves the rate in force on a date for display', () => {
    const withTwo = code({
      rateVersions: [
        { id: 'a', taxCodeId: 'tax-1', rate: '16.000000', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', outputTaxAccountId: null, createdAt: null },
        { id: 'b', taxCodeId: 'tax-1', rate: '18.000000', effectiveFrom: '2026-07-01', effectiveTo: null, outputTaxAccountId: null, createdAt: null },
      ],
    }) as never;

    expect(rateOn(withTwo, '2026-06-30')).toBe('16.000000');
    expect(rateOn(withTwo, '2026-07-01')).toBe('18.000000');
    expect(rateOn(withTwo, '2025-12-31')).toBeNull();
  });
});

/* ══ Writes go to the server ═══════════════════════════════════════════════ */

describe('lifecycle writes', () => {
  beforeEach(async () => { await useServerTaxCodeStore.getState().load(); });

  it('creates through the API and keeps the returned record', async () => {
    api.create.mockResolvedValue(code({ id: 'tax-2', code: 'VAT04' }));
    const result = await useServerTaxCodeStore.getState().createTaxCode({
      code: 'VAT04', name: 'Reduced', category: 'reduced',
      calculationMethod: 'exclusive', rate: '4', effectiveFrom: '2026-01-01',
    });

    expect(result.ok).toBe(true);
    expect(api.create).toHaveBeenCalledOnce();
    expect(useServerTaxCodeStore.getState().taxCodes.map((c) => c.id)).toContain('tax-2');
  });

  it('carries the version on an edit, so a stale write cannot win', async () => {
    api.update.mockResolvedValue(code({ version: 2, name: 'Renamed' }));
    await useServerTaxCodeStore.getState().updateTaxCode('tax-1', 1, { name: 'Renamed' });
    expect(api.update).toHaveBeenCalledWith('tax-1', 1, { name: 'Renamed' });
  });

  it('reports a refusal rather than throwing into a click handler', async () => {
    api.addRate.mockRejectedValue(new Error('Rate periods may not overlap.'));
    const result = await useServerTaxCodeStore.getState()
      .addRateVersion('tax-1', 1, { rate: '18', effectiveFrom: '2026-07-01' });

    /* A rejected promise inside a menu handler leaves the user looking at a
     * control that did nothing and said nothing. */
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/may not overlap/i);
  });

  it('drops an archived code from the working list', async () => {
    api.setStatus.mockResolvedValue(code({ status: 'archived' }));
    await useServerTaxCodeStore.getState().setStatus('tax-1', 1, 'archived');
    expect(useServerTaxCodeStore.getState().taxCodes).toHaveLength(0);
  });
});
