/**
 * The one place a screen asks what this company owns and how it is configured.
 *
 * Durable subscribers get the server register; Free Demo gets the local
 * `fixedAssetStore`. Screens do not branch on the engine themselves — a screen
 * that decided for itself is a screen that gets forgotten when the next domain
 * migrates.
 *
 * ══ The census, and why it is not an import ══════════════════════════════════
 *
 * A durable subscriber may still have fixed assets sitting in this browser from
 * before the cutover. They are COUNTED and named, never imported. Bringing one
 * across would mean the server deciding which of its accounts the browser
 * category meant, what the asset cost, when it was capitalised and how much had
 * already been depreciated — and all four came from a workspace it never held.
 * Each guess would be an invented fixed asset, which is the single thing an
 * asset register must not contain.
 */
import { useEffect, useMemo } from 'react';
import type {
  FixedAssetCapabilities,
  RegisterReport,
  ServerAssetCategory,
  ServerFixedAsset,
} from '@/services/api/fixedAssetsApi';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import {
  fixedAssetsAreServerAuthoritative,
  loadFixedAssetRegister,
  useServerFixedAssets,
} from './fixedAssetsBackend';

export interface FixedAssetRegisterView {
  serverBacked: boolean;
  categories: ServerAssetCategory[];
  assets: ServerFixedAsset[];
  report: RegisterReport | null;
  capabilities: FixedAssetCapabilities | null;
  loading: boolean;
  error: string | null;

  /**
   * How many records remain in THIS BROWSER but not in the books.
   *
   * Zero on a demo workspace, where the browser records ARE the register and
   * are not stranded at all.
   */
  strandedAssets: number;
  strandedCategories: number;

  /**
   * Categories that cannot carry a depreciation posting yet.
   *
   * Surfaced from the list rather than the report so the register screen can
   * warn without a second request — the report is the fuller answer.
   */
  categoriesMissingMappings: ServerAssetCategory[];
}

export function useFixedAssetRegister(): FixedAssetRegisterView {
  const serverBacked = fixedAssetsAreServerAuthoritative();
  const register = useServerFixedAssets();
  const localAssets = useFixedAssetStore((s) => s.assets);
  const localCategories = useFixedAssetStore((s) => s.categories);

  /* One load per mount for a durable workspace; the gateways re-read after
   * every write, so nothing else needs to ask. */
  useEffect(() => {
    if (serverBacked && register.assetState === 'idle') void loadFixedAssetRegister();
  }, [serverBacked, register.assetState]);

  const categoriesMissingMappings = useMemo(
    () => (serverBacked
      /*
       * A category that does not depreciate needs no depreciation accounts —
       * land is the case — so it is not missing anything by lacking them.
       */
      ? register.categories.filter(
        (category) => category.status === 'active'
          && !category.mappingComplete
          && !(category.defaultMethod === 'none' && category.assetCostAccountId),
      )
      : []),
    [serverBacked, register.categories],
  );

  return {
    serverBacked,
    categories: serverBacked ? register.categories : [],
    assets: serverBacked ? register.assets : [],
    report: serverBacked ? register.report : null,
    capabilities: serverBacked ? register.capabilities : null,
    loading: serverBacked
      && (register.assetState === 'loading' || register.categoryState === 'loading'),
    error: serverBacked ? (register.assetError ?? register.categoryError) : null,
    strandedAssets: serverBacked ? localAssets.length : 0,
    strandedCategories: serverBacked ? localCategories.length : 0,
    categoriesMissingMappings,
  };
}
