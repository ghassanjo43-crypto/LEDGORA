/**
 * The tax codes a durable subscriber's books actually hold.
 *
 * ══ Why this is not the browser tax store ════════════════════════════════════
 *
 * `taxCodeStore` persists to localStorage and seeds itself with sample codes.
 * That is right for a demo workspace, where the codes are the originals and
 * nothing else has them. It is wrong for a durable subscriber: an invoice line
 * names a tax code by id, the server holds a foreign key to it, and a code
 * invented in one browser tab is a code no invoice can ever be issued against.
 *
 * ══ Why there is no fallback ═════════════════════════════════════════════════
 *
 * The tempting failure mode is to fall back to the local seed when the fetch
 * fails, so the picker "still works". It would show codes that cannot be used,
 * and the invoice would be refused at save with a message about a code the user
 * can see on the screen in front of them. An empty picker and a stated error is
 * the honest state.
 */
import { create } from 'zustand';
import { booksEngine } from '@/services/books/booksEngine';
/*
 * From the COUNTER, not from `booksScope`. `booksScope` imports this store in
 * order to clear it on a company change, so importing it back would close a
 * cycle — and a cycle here resolves differently depending on which module the
 * graph reaches first, which silently turns that clearing into a no-op.
 */
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';
import {
  taxCodesApi,
  type ServerTaxCode,
  type TaxCodeCreateInput,
  type TaxCodeUpdateInput,
  type RateVersionInput,
} from '@/services/api/taxCodesApi';

export type TaxCodeBackend = 'browser' | 'server';

/**
 * Which store answers, from the same latched decision the chart, the journal,
 * the customers and the invoices already use. A workspace cannot have its
 * invoices on the server and its tax codes in a tab.
 */
export function taxCodeBackend(): TaxCodeBackend {
  return booksEngine() === 'server' ? 'server' : 'browser';
}

export interface TaxActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const failed = (cause: unknown, fallback: string): TaxActionResult => ({
  ok: false,
  error: cause instanceof Error && cause.message ? cause.message : fallback,
});

interface ServerTaxCodeState {
  taxCodes: ServerTaxCode[];
  loading: boolean;
  loadError?: string;
  loaded: boolean;

  load: (options?: { includeArchived?: boolean }) => Promise<void>;
  createTaxCode: (input: TaxCodeCreateInput) => Promise<TaxActionResult>;
  updateTaxCode: (id: string, expectedVersion: number, input: TaxCodeUpdateInput) => Promise<TaxActionResult>;
  addRateVersion: (id: string, expectedVersion: number, input: RateVersionInput) => Promise<TaxActionResult>;
  setStatus: (id: string, expectedVersion: number, status: ServerTaxCode['status']) => Promise<TaxActionResult>;

  /** Codes a NEW invoice line may choose on a given date. */
  selectableOn: (date: string) => ServerTaxCode[];
  getTaxCode: (id: string) => ServerTaxCode | undefined;
}

function upsert(list: ServerTaxCode[], code: ServerTaxCode): ServerTaxCode[] {
  const index = list.findIndex((candidate) => candidate.id === code.id);
  if (index === -1) return [...list, code].sort((a, b) => a.code.localeCompare(b.code));
  const next = [...list];
  next[index] = code;
  return next;
}

export const useServerTaxCodeStore = create<ServerTaxCodeState>()((set, get) => ({
  taxCodes: [],
  loading: false,
  loaded: false,

  load: async (options = {}) => {
    if (taxCodeBackend() !== 'server') {
      set({ taxCodes: [], loading: false, loadError: undefined, loaded: true });
      return;
    }
    /*
     * The company can change at the await below. Applying a late answer would
     * offer one company's tax codes on another company's invoice — and the
     * server would then refuse the code with a message the user cannot act on.
     */
    const generation = booksGeneration();
    set({ loading: true, loadError: undefined });
    try {
      const taxCodes = await taxCodesApi.list(options);
      if (!isCurrentGeneration(generation)) return;
      set({ taxCodes, loading: false, loaded: true });
    } catch (cause) {
      if (!isCurrentGeneration(generation)) return;
      /* No fallback to the local seed — see the header. */
      set({
        loading: false,
        loaded: true,
        loadError: cause instanceof Error ? cause.message : 'Could not load the tax codes.',
      });
    }
  },

  createTaxCode: async (input) => {
    try {
      const created = await taxCodesApi.create(input);
      set({ taxCodes: upsert(get().taxCodes, created) });
      return { ok: true, id: created.id };
    } catch (cause) {
      return failed(cause, 'Could not create the tax code.');
    }
  },

  updateTaxCode: async (id, expectedVersion, input) => {
    try {
      const updated = await taxCodesApi.update(id, expectedVersion, input);
      set({ taxCodes: upsert(get().taxCodes, updated) });
      return { ok: true, id };
    } catch (cause) {
      return failed(cause, 'Could not save the tax code.');
    }
  },

  addRateVersion: async (id, expectedVersion, input) => {
    try {
      const updated = await taxCodesApi.addRate(id, expectedVersion, input);
      set({ taxCodes: upsert(get().taxCodes, updated) });
      return { ok: true, id };
    } catch (cause) {
      return failed(cause, 'Could not add the rate.');
    }
  },

  setStatus: async (id, expectedVersion, status) => {
    try {
      const updated = await taxCodesApi.setStatus(id, expectedVersion, status);
      set({
        taxCodes: status === 'archived'
          ? get().taxCodes.filter((code) => code.id !== id)
          : upsert(get().taxCodes, updated),
      });
      return { ok: true, id };
    } catch (cause) {
      return failed(cause, 'Could not change the tax code status.');
    }
  },

  /**
   * Selectable means the server would accept it — active, and effective on the
   * date, with a rate in force. Offering anything else produces a refusal at
   * save time for a code the user is looking at.
   */
  selectableOn: (date) => get().taxCodes.filter((code) => {
    if (code.status !== 'active') return false;
    if (code.effectiveFrom > date) return false;
    if (code.effectiveTo && code.effectiveTo < date) return false;
    return code.rateVersions.some((version) =>
      date >= version.effectiveFrom && (!version.effectiveTo || date <= version.effectiveTo));
  }),

  getTaxCode: (id) => get().taxCodes.find((code) => code.id === id),
}));

/** The rate in force on a date, for display only — the server decides at save. */
export function rateOn(code: ServerTaxCode, date: string): string | null {
  const version = code.rateVersions.find((candidate) =>
    date >= candidate.effectiveFrom && (!candidate.effectiveTo || date <= candidate.effectiveTo));
  return version ? version.rate : null;
}
