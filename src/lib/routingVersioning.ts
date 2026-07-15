/**
 * Routing approval, immutability and versioning. Approved routings are
 * immutable; editing one creates a new version. Operation numbers are unique
 * within a routing.
 */
import type { ManufacturingRouting } from '@/types/manufacturing';

export interface VersioningResult {
  ok: boolean;
  error?: string;
}

export function canEditRouting(routing: Pick<ManufacturingRouting, 'status'>): boolean {
  return routing.status === 'draft';
}

export function validateRouting(routing: ManufacturingRouting): VersioningResult {
  if (!routing.code.trim()) return { ok: false, error: 'Routing code is required.' };
  if (!routing.productItemId) return { ok: false, error: 'Select the product.' };
  if (routing.operations.length === 0) return { ok: false, error: 'A routing needs at least one operation.' };
  const seen = new Set<number>();
  for (const op of routing.operations) {
    if (!op.workCenterId) return { ok: false, error: 'Every operation needs a work center.' };
    if (op.setupHours < 0 || op.runHoursPerUnit < 0) return { ok: false, error: 'Operation hours cannot be negative.' };
    if (seen.has(op.operationNumber)) return { ok: false, error: `Duplicate operation number ${op.operationNumber}.` };
    seen.add(op.operationNumber);
  }
  return { ok: true };
}

export function nextRoutingVersion(all: ManufacturingRouting[], productItemId: string): number {
  const versions = all.filter((r) => r.productItemId === productItemId).map((r) => r.version);
  return (versions.length ? Math.max(...versions) : 0) + 1;
}

export function makeNewRoutingVersion(source: ManufacturingRouting, all: ManufacturingRouting[], now: string): ManufacturingRouting {
  return {
    ...source,
    id: `rtg_${Math.random().toString(36).slice(2, 10)}`,
    version: nextRoutingVersion(all, source.productItemId),
    status: 'draft',
    approvedAt: undefined,
    approvedBy: undefined,
    effectiveFrom: now.slice(0, 10),
    effectiveTo: undefined,
    createdAt: now,
    updatedAt: now,
    operations: source.operations.map((o, i) => ({ ...o, id: `op_${Math.random().toString(36).slice(2, 8)}_${i}` })),
  };
}
