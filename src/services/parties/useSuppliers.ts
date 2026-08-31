/**
 * The one place a screen asks "who are this company's suppliers".
 *
 * Durable subscribers get the server directory; Free Demo gets the local entity
 * store. Screens do not branch on the engine themselves — a screen that decided
 * for itself is a screen that can be forgotten when the next role migrates.
 *
 * The server party is mapped into `BusinessEntity`, the shape every existing
 * picker, drawer and selector already consumes, by the same `partyToEntity` the
 * customer directory uses. That is what keeps this slice small: nothing
 * downstream has to learn a second supplier type.
 */
import { useMemo } from 'react';
import type { BusinessEntity } from '@/types';
import { useEntityStore } from '@/store/useEntityStore';
import { isSupplier } from '@/lib/entitySelectors';
import { partyToEntity } from './useCustomers';
import { useSupplierDirectory, suppliersAreServerAuthoritative } from './supplierDirectory';

export interface SupplierDirectoryView {
  suppliers: BusinessEntity[];
  /** True when these came from the server rather than the browser. */
  serverBacked: boolean;
  loading: boolean;
  error: string | null;
  /**
   * How many suppliers the books hold, ignoring any search. `null` until known.
   *
   * A screen needs this to explain an empty table honestly: "no suppliers yet"
   * and "none match this search" are different, and neither is "the list broke".
   */
  total: number | null;
}

export function useSuppliers(): SupplierDirectoryView {
  const serverBacked = suppliersAreServerAuthoritative();
  const directory = useSupplierDirectory();
  const localEntities = useEntityStore((s) => s.entities);

  const suppliers = useMemo(() => {
    if (serverBacked) return directory.suppliers.map(partyToEntity);
    /* Free Demo: the local directory, filtered to the supplier role exactly as
     * every picker already did. */
    return localEntities.filter(isSupplier);
  }, [serverBacked, directory.suppliers, localEntities]);

  return {
    suppliers,
    serverBacked,
    loading: serverBacked && directory.state === 'loading',
    error: serverBacked ? directory.error : null,
    total: serverBacked ? directory.total : localEntities.filter(isSupplier).length,
  };
}
