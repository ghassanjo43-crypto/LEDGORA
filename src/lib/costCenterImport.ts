import type { CostCenter, CostCenterType } from '@/types/costCenter';
import { parseCsv, escapeCsv, toBool } from '@/lib/csv';
import { wouldCreateCycle } from '@/lib/costCenterHierarchy';
import { generateId, nowIso } from '@/lib/utils';

/**
 * Cost-center CSV/Excel import with a DRY-RUN preview (§51). Validates duplicate
 * codes, unknown parent codes, circular hierarchy, entity mismatch, invalid dates,
 * status and flags — reporting accepted/rejected rows and reasons BEFORE commit.
 */

const TYPES: CostCenterType[] = ['operating', 'administrative', 'sales', 'production', 'service', 'support', 'shared', 'corporate', 'custom'];
const STATUSES = ['active', 'inactive', 'archived'];
const HEADERS = ['entity', 'code', 'name', 'description', 'type', 'parentCode', 'manager', 'postingAllowed', 'budgetEnabled', 'effectiveFrom', 'effectiveTo', 'status'];

export interface ImportRowResult {
  rowNumber: number;
  raw: Record<string, string>;
  accepted: boolean;
  errors: string[];
  /** The cost center to create when accepted (parent resolved at commit). */
  draft?: Omit<CostCenter, 'parentId' | 'hierarchyPath' | 'level'> & { parentCode?: string };
}

export interface ImportDryRun {
  rows: ImportRowResult[];
  acceptedCount: number;
  rejectedCount: number;
  headerError?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a CSV import against the existing centers WITHOUT mutating anything.
 * `entityId` scopes uniqueness and parent resolution.
 */
export function dryRunCostCenterImport(csvText: string, existing: CostCenter[], entityId: string): ImportDryRun {
  const table = parseCsv(csvText.trim());
  if (table.length === 0) return { rows: [], acceptedCount: 0, rejectedCount: 0, headerError: 'The file is empty.' };

  const header = table[0]!.map((h) => h.trim());
  const missing = ['code', 'name'].filter((h) => !header.includes(h));
  if (missing.length) return { rows: [], acceptedCount: 0, rejectedCount: 0, headerError: `Missing required column(s): ${missing.join(', ')}.` };
  const col = (row: string[], name: string): string => (header.includes(name) ? (row[header.indexOf(name)] ?? '').trim() : '');

  const existingCodes = new Map(existing.filter((c) => c.entityId === entityId).map((c) => [c.code.toLowerCase(), c]));
  const codeToRow = new Map<string, number>();
  const importedCodes = new Set<string>();
  const now = nowIso();
  const rows: ImportRowResult[] = [];

  // First pass — collect the codes being imported (for parent resolution).
  table.slice(1).forEach((r) => { const code = col(r, 'code').toLowerCase(); if (code) importedCodes.add(code); });

  table.slice(1).forEach((r, i) => {
    const rowNumber = i + 2; // 1-based incl header
    const raw: Record<string, string> = Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? '').trim()]));
    const errors: string[] = [];
    const code = col(r, 'code');
    const name = col(r, 'name');
    const type = (col(r, 'type') || 'operating') as CostCenterType;
    const parentCode = col(r, 'parentCode');
    const status = (col(r, 'status') || 'active') as CostCenter['status'];
    const effFrom = col(r, 'effectiveFrom') || now.slice(0, 10);
    const effTo = col(r, 'effectiveTo');
    const rowEntity = col(r, 'entity') || entityId;
    const postingRaw = col(r, 'postingAllowed');
    const budgetRaw = col(r, 'budgetEnabled');

    if (!code) errors.push('Code is required.');
    if (!name) errors.push('Name is required.');
    if (rowEntity !== entityId) errors.push(`Entity "${rowEntity}" does not match the target entity "${entityId}".`);
    if (code) {
      const lc = code.toLowerCase();
      if (existingCodes.has(lc)) errors.push(`Code "${code}" already exists in this entity.`);
      if (codeToRow.has(lc)) errors.push(`Duplicate code "${code}" appears earlier in the file (row ${codeToRow.get(lc)}).`);
      codeToRow.set(lc, rowNumber);
    }
    if (type && !TYPES.includes(type)) errors.push(`Invalid type "${type}".`);
    if (status && !STATUSES.includes(status)) errors.push(`Invalid status "${status}".`);
    if (postingRaw && !/^(true|false|yes|no|1|0|y|n)$/i.test(postingRaw)) errors.push(`Invalid postingAllowed flag "${postingRaw}".`);
    if (budgetRaw && !/^(true|false|yes|no|1|0|y|n)$/i.test(budgetRaw)) errors.push(`Invalid budgetEnabled flag "${budgetRaw}".`);
    if (!ISO_DATE.test(effFrom)) errors.push(`Invalid effectiveFrom date "${effFrom}" (expected YYYY-MM-DD).`);
    if (effTo && !ISO_DATE.test(effTo)) errors.push(`Invalid effectiveTo date "${effTo}".`);
    if (effTo && ISO_DATE.test(effTo) && ISO_DATE.test(effFrom) && effTo < effFrom) errors.push('effectiveTo precedes effectiveFrom.');

    // Parent must exist (already or in this import) and not create a cycle.
    if (parentCode) {
      const lcParent = parentCode.toLowerCase();
      if (!existingCodes.has(lcParent) && !importedCodes.has(lcParent)) errors.push(`Unknown parent code "${parentCode}".`);
      if (lcParent === code.toLowerCase()) errors.push('A cost center cannot be its own parent.');
      const parentExisting = existingCodes.get(lcParent);
      const selfExisting = existingCodes.get(code.toLowerCase());
      if (parentExisting && selfExisting && wouldCreateCycle(existing, selfExisting.id, parentExisting.id)) errors.push('This parent assignment would create a circular hierarchy.');
    }

    const accepted = errors.length === 0;
    rows.push({
      rowNumber, raw, accepted, errors,
      draft: accepted ? {
        id: generateId('cc'), entityId, code, name, description: col(r, 'description') || undefined, type, status,
        sortOrder: i, managerName: col(r, 'manager') || undefined, effectiveFrom: effFrom, effectiveTo: effTo || undefined,
        isPostingAllowed: postingRaw ? toBool(postingRaw) : true, isBudgetEnabled: budgetRaw ? toBool(budgetRaw) : true,
        isAllocationSource: false, isAllocationTarget: true,
        auditTrail: [{ id: generateId('ccaud'), at: now, action: 'cost-center-created', detail: 'import' }], createdAt: now, updatedAt: now,
        parentCode: parentCode || undefined,
      } : undefined,
    });
  });

  return { rows, acceptedCount: rows.filter((r) => r.accepted).length, rejectedCount: rows.filter((r) => !r.accepted).length };
}

/**
 * Turn accepted dry-run rows into real cost centers, resolving parent codes to
 * ids (across existing + newly-imported) and computing hierarchy paths.
 */
export function commitCostCenterImport(dryRun: ImportDryRun, existing: CostCenter[]): CostCenter[] {
  const accepted = dryRun.rows.filter((r) => r.accepted && r.draft);
  const byCode = new Map<string, { id: string; parentId?: string }>();
  for (const c of existing) byCode.set(c.code.toLowerCase(), { id: c.id, parentId: c.parentId });
  for (const r of accepted) byCode.set(r.draft!.code.toLowerCase(), { id: r.draft!.id, parentId: undefined });

  const created: CostCenter[] = accepted.map((r) => {
    const { parentCode, ...rest } = r.draft!;
    const parentId = parentCode ? byCode.get(parentCode.toLowerCase())?.id : undefined;
    return { ...rest, parentId, hierarchyPath: [rest.id], level: 0 } as CostCenter;
  });

  // Recompute paths across existing + created.
  const all = [...existing, ...created];
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const c of created) {
    const path: string[] = [c.id];
    let level = 0;
    let cur = c.parentId;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) { guard.add(cur); path.unshift(cur); level += 1; cur = byId.get(cur)?.parentId; }
    c.hierarchyPath = path;
    c.level = level;
  }
  return created;
}

/** Export the current cost centers to CSV (round-trips with the import format). */
export function exportCostCentersCsv(centers: CostCenter[]): string {
  const byId = new Map(centers.map((c) => [c.id, c]));
  const lines = [HEADERS.join(',')];
  for (const c of centers) {
    const parentCode = c.parentId ? byId.get(c.parentId)?.code ?? '' : '';
    lines.push([c.entityId, c.code, c.name, c.description ?? '', c.type, parentCode, c.managerName ?? '', String(c.isPostingAllowed), String(c.isBudgetEnabled), c.effectiveFrom, c.effectiveTo ?? '', c.status].map((v) => escapeCsv(String(v))).join(','));
  }
  return lines.join('\n');
}
