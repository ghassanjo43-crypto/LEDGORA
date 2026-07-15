import type { CostCenter, CostCenterSnapshot } from '@/types/costCenter';

/**
 * Freeze a cost center's identity onto a posted line (§47) so historical
 * documents stay understandable after a later rename, move, deactivation or
 * archive. Reports may present the current or the historical hierarchy.
 */
export function createCostCenterSnapshot(center: CostCenter, capturedAt: string): CostCenterSnapshot {
  return {
    costCenterId: center.id,
    code: center.code,
    name: center.name,
    hierarchyPath: [...center.hierarchyPath],
    capturedAt,
  };
}
