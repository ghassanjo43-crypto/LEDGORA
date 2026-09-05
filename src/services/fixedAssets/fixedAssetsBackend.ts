/**
 * Where the fixed-asset register and its categories actually live.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 * A durable subscriber's register is on the server; Free Demo keeps the local
 * `fixedAssetStore`, which is disposable by design and stays exactly as it is.
 * One workspace cannot split its books from its asset register, so the verdict
 * comes from `booksEngine` and nothing here decides it independently.
 *
 * ══ There is no browser fallback, on purpose ═════════════════════════════════
 *
 * When the server cannot answer, these read EMPTY and the screen says so. A
 * durable subscriber whose asset register silently fell back to browser storage
 * would be looking at a list their books have never seen — and would find out
 * on the day they tried to depreciate it. "Could not load" is recoverable;
 * "loaded something that does not count" is not.
 *
 * Writes have no fallback either. A refused save is reported as refused; it is
 * never written locally "so the user does not lose their work", because the
 * next hydration would delete it without a word.
 *
 * ══ Why writes re-read ═══════════════════════════════════════════════════════
 *
 * Every write goes to the server and then re-lists, rather than patching the
 * cache with what was sent. The server bumps the version, trims the strings,
 * allocates the asset code and normalises the decimals; echoing the request
 * would leave the screen disagreeing with the register on the very next save.
 */
import { create } from 'zustand';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';
import {
  fixedAssetCategoriesApi,
  fixedAssetsApi,
  type AssetWriteInput,
  type CategoryWriteInput,
  type FixedAssetCapabilities,
  type RegisterReport,
  type ServerAssetCategory,
  type ServerFixedAsset,
} from '@/services/api/fixedAssetsApi';

export type FixedAssetBackend = 'browser' | 'server';

export function fixedAssetBackend(): FixedAssetBackend {
  return booksEngine() === 'server' ? 'server' : 'browser';
}

export function fixedAssetsAreServerAuthoritative(): boolean {
  return fixedAssetBackend() === 'server';
}

export type RegisterState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface FixedAssetStoreShape {
  categoryState: RegisterState;
  categories: ServerAssetCategory[];
  categoryError: string | null;

  assetState: RegisterState;
  assets: ServerFixedAsset[];
  assetError: string | null;
  assetSearch: string;
  /** '' means every status, archived included — see `loadAssets`. */
  assetStatusFilter: '' | 'draft' | 'archived';

  report: RegisterReport | null;
  reportState: RegisterState;

  capabilities: FixedAssetCapabilities | null;
}

export const useServerFixedAssets = create<FixedAssetStoreShape>(() => ({
  categoryState: 'idle',
  categories: [],
  categoryError: null,
  assetState: 'idle',
  assets: [],
  assetError: null,
  assetSearch: '',
  assetStatusFilter: '',
  report: null,
  reportState: 'idle',
  capabilities: null,
}));

/**
 * Empty every register, synchronously.
 *
 * Called on a company change BEFORE anything is fetched: a bookkeeper spending
 * the loading interval looking at the previous company's asset register is how
 * somebody depreciates the wrong machine.
 */
export function clearFixedAssetCache(): void {
  useServerFixedAssets.setState({
    categoryState: 'idle', categories: [], categoryError: null,
    assetState: 'idle', assets: [], assetError: null,
    assetSearch: '', assetStatusFilter: '',
    report: null, reportState: 'idle',
    capabilities: null,
  });
}

/**
 * A response is applied only if the books generation that issued it is still
 * current — the company can change at any await, and a late answer would list
 * one company's assets under another company's name.
 */
export async function loadCategories(): Promise<void> {
  if (!fixedAssetsAreServerAuthoritative()) return;

  const generation = booksGeneration();
  useServerFixedAssets.setState({ categoryState: 'loading', categoryError: null });

  try {
    const categories = await fixedAssetCategoriesApi.list({ limit: 500 });
    if (!isCurrentGeneration(generation)) return;
    useServerFixedAssets.setState({
      categoryState: 'ready', categories, categoryError: null,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    /* Empty and SAID to be empty. Never the browser's seeded categories, whose
     * account mappings were resolved against a chart this server never held. */
    useServerFixedAssets.setState({
      categoryState: 'unavailable',
      categories: [],
      categoryError: cause instanceof Error
        ? cause.message
        : 'Could not load the asset categories.',
    });
  }
}

export async function loadAssets(
  options: { search?: string; status?: '' | 'draft' | 'archived' } = {},
): Promise<void> {
  if (!fixedAssetsAreServerAuthoritative()) return;

  const generation = booksGeneration();
  const state = useServerFixedAssets.getState();
  const search = options.search ?? state.assetSearch;
  const status = options.status ?? state.assetStatusFilter;
  useServerFixedAssets.setState({
    assetState: 'loading', assetError: null, assetSearch: search, assetStatusFilter: status,
  });

  try {
    /*
     * No status means EVERY status, archived included. An archived asset is the
     * record of something the business owned; a register that hid it by default
     * would answer "we never had one" to somebody who knows otherwise.
     */
    const assets = await fixedAssetsApi.list({
      search: search || undefined,
      status: status || undefined,
      limit: 500,
    });
    if (!isCurrentGeneration(generation)) return;
    useServerFixedAssets.setState({
      assetState: 'ready', assets, assetError: null, assetSearch: search, assetStatusFilter: status,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useServerFixedAssets.setState({
      assetState: 'unavailable',
      assets: [],
      assetError: cause instanceof Error ? cause.message : 'Could not load the asset register.',
    });
  }
}

export async function loadRegisterReport(): Promise<void> {
  if (!fixedAssetsAreServerAuthoritative()) return;
  const generation = booksGeneration();
  useServerFixedAssets.setState({ reportState: 'loading' });
  try {
    const report = await fixedAssetsApi.registerReport();
    if (!isCurrentGeneration(generation)) return;
    useServerFixedAssets.setState({ reportState: 'ready', report });
  } catch {
    if (!isCurrentGeneration(generation)) return;
    useServerFixedAssets.setState({ reportState: 'unavailable', report: null });
  }
}

export async function loadCapabilities(): Promise<void> {
  if (!fixedAssetsAreServerAuthoritative()) return;
  const generation = booksGeneration();
  try {
    const capabilities = await fixedAssetsApi.capabilities();
    if (!isCurrentGeneration(generation)) return;
    useServerFixedAssets.setState({ capabilities });
  } catch {
    /* A screen without the capability list falls back to the constants below,
     * which say the same thing. Nothing is claimed to work that does not. */
  }
}

/** Everything a durable Fixed Assets screen needs, in one call. */
export async function loadFixedAssetRegister(): Promise<void> {
  if (!fixedAssetsAreServerAuthoritative()) return;
  await Promise.all([loadCapabilities(), loadCategories(), loadAssets()]);
}

export const categoryGateway = {
  create: async (input: CategoryWriteInput): Promise<ServerAssetCategory> => {
    const created = await fixedAssetCategoriesApi.create(input);
    await loadCategories();
    return created;
  },

  update: async (
    id: string, expectedVersion: number, input: CategoryWriteInput,
  ): Promise<ServerAssetCategory> => {
    const updated = await fixedAssetCategoriesApi.update(id, expectedVersion, input);
    await loadCategories();
    return updated;
  },

  setArchived: async (
    id: string, expectedVersion: number, archived: boolean,
  ): Promise<ServerAssetCategory> => {
    const changed = await fixedAssetCategoriesApi.setArchived(id, expectedVersion, archived);
    /* Both: archiving a category changes the count an asset list shows against
     * it, and reactivating one puts it back in the picker. */
    await Promise.all([loadCategories(), loadAssets()]);
    return changed;
  },

  history: (id: string) => fixedAssetCategoriesApi.history(id),
};

export const assetGateway = {
  create: async (input: AssetWriteInput): Promise<ServerFixedAsset> => {
    const created = await fixedAssetsApi.create(input);
    await Promise.all([loadAssets(), loadCategories()]);
    return created;
  },

  update: async (
    id: string, expectedVersion: number, input: AssetWriteInput,
  ): Promise<ServerFixedAsset> => {
    const updated = await fixedAssetsApi.update(id, expectedVersion, input);
    await Promise.all([loadAssets(), loadCategories()]);
    return updated;
  },

  setArchived: async (
    id: string, expectedVersion: number, archived: boolean, reason = '',
  ): Promise<ServerFixedAsset> => {
    const changed = await fixedAssetsApi.setArchived(id, expectedVersion, archived, reason);
    await Promise.all([loadAssets(), loadCategories()]);
    return changed;
  },

  history: (id: string) => fixedAssetsApi.history(id),
};

export function serverCategoryById(id: string): ServerAssetCategory | undefined {
  return useServerFixedAssets.getState().categories.find((category) => category.id === id);
}

export function serverAssetById(id: string): ServerFixedAsset | undefined {
  return useServerFixedAssets.getState().assets.find((asset) => asset.id === id);
}

/* ── What F1 deliberately does not offer ──────────────────────────────────── */

/*
 * The screens render the SERVER's sentences when it has answered, and these
 * when it has not. They say the same thing, because a refusal a bookkeeper
 * reads twice in two different wordings is a refusal they stop believing.
 */

export const CAPITALIZATION_UNSUPPORTED =
  'Capitalisation is not available yet. Recording an asset’s cost creates a journal — Dr the asset, '
  + 'Cr whatever paid for it — and this release posts nothing. The register names the asset and the '
  + 'policy that will apply to it; the cost arrives with the posting that puts it in the books.';

export const DEPRECIATION_UNSUPPORTED =
  'Depreciation is not available yet. No schedule is generated, no run is stored and no accumulated '
  + 'depreciation is posted. This release records the POLICY — method, useful life, residual value, '
  + 'convention and the accounts a charge will use — and nothing that has been charged.';

export const DISPOSAL_UNSUPPORTED =
  'Disposal, sale, write-off and retirement are not available yet. Each derecognises a cost and an '
  + 'accumulated depreciation this release has never posted, so there is nothing here to remove. '
  + 'Archiving an asset takes it out of the working register and is not a disposal.';

export const IMPAIRMENT_UNSUPPORTED =
  'Impairment and impairment reversal are not available yet. Both measure a carrying amount against '
  + 'a recoverable one, and this release holds no carrying amount.';

export const REVALUATION_UNSUPPORTED =
  'Revaluation is not available yet. It restates a carrying amount this release does not hold.';

export const BILL_ACQUISITION_UNSUPPORTED =
  'A supplier bill cannot create or capitalise a fixed asset yet. What a capital purchase costs, '
  + 'when it is capitalised, how input tax is treated, what happens on a partial capitalisation and '
  + 'what a reversal must undo are all decisions this release has not made. Register the asset here, '
  + 'and record the bill as it stands. Naming a supplier on an asset is a note about where it came '
  + 'from; it links no document and posts nothing.';

/**
 * The census sentence.
 *
 * Records left in this browser are NOT imported. The server would have to
 * decide which chart account each browser category meant, what each asset cost,
 * when it was capitalised and how much had already been depreciated — and every
 * one of those came from a workspace it never held. A guess would be invented
 * fixed assets, which is the one thing an asset register must never contain.
 */
export const IMPORT_REQUIRED =
  'Fixed assets in this browser are not durable and cannot be imported automatically. Their '
  + 'categories name accounts from a chart this server never held, and their costs, capitalisation '
  + 'dates and accumulated depreciation came from postings it never made — so every mapping would '
  + 'be a guess about your fixed assets. Re-enter the ones you still need; nothing here has been '
  + 'deleted.';
