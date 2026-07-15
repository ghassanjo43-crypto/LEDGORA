/**
 * BOM approval, immutability and versioning. Approved BOMs are immutable;
 * editing one produces a NEW version (higher `version`, back to draft). A
 * circular-reference guard prevents a manufacturable component from ever
 * (transitively) containing its own product.
 */
import type { BillOfMaterials } from '@/types/manufacturing';

export interface VersioningResult {
  ok: boolean;
  error?: string;
}

/** Only a draft BOM may be edited in place; approved ones are frozen. */
export function canEditBom(bom: Pick<BillOfMaterials, 'status'>): boolean {
  return bom.status === 'draft';
}

/** Validate a BOM's shape prior to save/approval. */
export function validateBom(bom: BillOfMaterials): VersioningResult {
  if (!bom.code.trim()) return { ok: false, error: 'BOM code is required.' };
  if (!bom.productItemId) return { ok: false, error: 'Select the finished product.' };
  if (!(bom.outputQuantity > 0)) return { ok: false, error: 'Output quantity must be positive.' };
  if (bom.components.length === 0) return { ok: false, error: 'A BOM needs at least one component.' };
  for (const c of bom.components) {
    if (!c.itemId) return { ok: false, error: 'Every component must reference an item.' };
    if (!(c.quantityPerOutput > 0)) return { ok: false, error: 'Component quantity per output must be positive.' };
    if (c.itemId === bom.productItemId) return { ok: false, error: 'A product cannot be a component of its own BOM.' };
  }
  return { ok: true };
}

/**
 * Detect a circular reference: does producing `productItemId` (via `candidate`'s
 * components) transitively require `productItemId` itself? `bomsByProduct` maps a
 * product item id to its APPROVED BOM (for subassembly expansion).
 */
export function hasCircularReference(
  productItemId: string,
  components: { itemId: string }[],
  bomsByProduct: Map<string, BillOfMaterials>,
): boolean {
  const visiting = new Set<string>();
  const visit = (itemId: string): boolean => {
    if (itemId === productItemId) return true;
    if (visiting.has(itemId)) return false;
    visiting.add(itemId);
    const sub = bomsByProduct.get(itemId);
    if (sub) {
      for (const c of sub.components) if (visit(c.itemId)) return true;
    }
    return false;
  };
  return components.some((c) => visit(c.itemId));
}

/** The next version number for a product's BOM family. */
export function nextBomVersion(all: BillOfMaterials[], productItemId: string): number {
  const versions = all.filter((b) => b.productItemId === productItemId).map((b) => b.version);
  return (versions.length ? Math.max(...versions) : 0) + 1;
}

/** Build a fresh draft copy of an approved BOM as a new version. */
export function makeNewBomVersion(source: BillOfMaterials, all: BillOfMaterials[], now: string): BillOfMaterials {
  return {
    ...source,
    id: `bom_${Math.random().toString(36).slice(2, 10)}`,
    version: nextBomVersion(all, source.productItemId),
    status: 'draft',
    approvedAt: undefined,
    approvedBy: undefined,
    effectiveFrom: now.slice(0, 10),
    effectiveTo: undefined,
    createdAt: now,
    updatedAt: now,
    components: source.components.map((c, i) => ({ ...c, id: `bc_${Math.random().toString(36).slice(2, 8)}_${i}` })),
  };
}
