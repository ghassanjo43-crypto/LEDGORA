/**
 * Manufacturing master-data + document validation (pure predicates shared by
 * the store and UI).
 */
import type { ManufacturingPlant, ProductionLine, WorkCenter } from '@/types/manufacturing';

export interface MfgValidation {
  ok: boolean;
  error?: string;
}
const OK: MfgValidation = { ok: true };

function uniqueCode(existing: { id: string; code: string }[], id: string, code: string): boolean {
  return !existing.some((e) => e.id !== id && e.code.trim().toLowerCase() === code.trim().toLowerCase());
}

export function validatePlant(plant: Pick<ManufacturingPlant, 'id' | 'code' | 'name'>, existing: ManufacturingPlant[]): MfgValidation {
  if (!plant.code.trim()) return { ok: false, error: 'Plant code is required.' };
  if (!plant.name.trim()) return { ok: false, error: 'Plant name is required.' };
  if (!uniqueCode(existing, plant.id, plant.code)) return { ok: false, error: `Plant code "${plant.code}" already exists.` };
  return OK;
}

export function validateProductionLine(line: Pick<ProductionLine, 'id' | 'code' | 'name' | 'plantId'>, existing: ProductionLine[]): MfgValidation {
  if (!line.code.trim()) return { ok: false, error: 'Line code is required.' };
  if (!line.plantId) return { ok: false, error: 'A production line must belong to a plant.' };
  if (!uniqueCode(existing, line.id, line.code)) return { ok: false, error: `Line code "${line.code}" already exists.` };
  return OK;
}

export function validateWorkCenter(wc: Pick<WorkCenter, 'id' | 'code' | 'name' | 'plantId' | 'costCenterId'>, existing: WorkCenter[]): MfgValidation {
  if (!wc.code.trim()) return { ok: false, error: 'Work-center code is required.' };
  if (!wc.plantId) return { ok: false, error: 'A work center must belong to a plant.' };
  if (!wc.costCenterId) return { ok: false, error: 'A work center requires a cost center.' };
  if (!uniqueCode(existing, wc.id, wc.code)) return { ok: false, error: `Work-center code "${wc.code}" already exists.` };
  return OK;
}
