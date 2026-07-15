import type { CostCenter, CostCenterRequirementRule, CostCenterType } from '@/types/costCenter';

/**
 * Default cost-center hierarchy DATA (not business logic):
 *   Corporate → Administration (Finance, HR) · Sales (Domestic, International)
 *             · Operations (Production, Logistics) · Shared Services
 * Requirement rules mark P&L accounts as required and bank/tax accounts as
 * prohibited. Account references use the deterministic seed CoA ids.
 */

const TS = new Date('2026-01-01T00:00:00.000Z').toISOString();
export const PRIMARY_ENTITY_ID = 'primary';

interface Spec { code: string; name: string; type: CostCenterType; parent?: string; posting?: boolean; source?: boolean; }

const SPECS: Spec[] = [
  { code: 'CC-CORP', name: 'Corporate', type: 'corporate', posting: false },
  { code: 'CC-ADMIN', name: 'Administration', type: 'administrative', parent: 'CC-CORP', posting: false },
  { code: 'CC-FIN', name: 'Finance', type: 'administrative', parent: 'CC-ADMIN' },
  { code: 'CC-HR', name: 'Human Resources', type: 'administrative', parent: 'CC-ADMIN' },
  { code: 'CC-SALES', name: 'Sales', type: 'sales', parent: 'CC-CORP', posting: false },
  { code: 'CC-SALES-DOM', name: 'Domestic Sales', type: 'sales', parent: 'CC-SALES' },
  { code: 'CC-SALES-INT', name: 'International Sales', type: 'sales', parent: 'CC-SALES' },
  { code: 'CC-OPS', name: 'Operations', type: 'operating', parent: 'CC-CORP', posting: false },
  { code: 'CC-PROD', name: 'Production', type: 'production', parent: 'CC-OPS' },
  { code: 'CC-LOG', name: 'Logistics', type: 'support', parent: 'CC-OPS' },
  { code: 'CC-SHARED', name: 'Shared Services', type: 'shared', parent: 'CC-CORP', source: true },
];

function build(): CostCenter[] {
  const byCode = new Map<string, CostCenter>();
  const idOf = (code: string) => `cc_${code}`;
  const out: CostCenter[] = [];
  // SPECS is ordered parent-before-child so paths resolve in one pass.
  SPECS.forEach((s, idx) => {
    const parent = s.parent ? byCode.get(s.parent) : undefined;
    const cc: CostCenter = {
      id: idOf(s.code), entityId: PRIMARY_ENTITY_ID, code: s.code, name: s.name, type: s.type, status: 'active',
      parentId: parent?.id,
      hierarchyPath: parent ? [...parent.hierarchyPath, idOf(s.code)] : [idOf(s.code)],
      level: parent ? parent.level + 1 : 0,
      sortOrder: idx,
      effectiveFrom: '2026-01-01',
      isPostingAllowed: s.posting ?? true,
      isBudgetEnabled: true,
      isAllocationSource: s.source ?? false,
      isAllocationTarget: (s.posting ?? true),
      auditTrail: [{ id: `ccaud_${s.code}`, at: TS, action: 'cost-center-created', detail: 'seed' }],
      createdAt: TS, updatedAt: TS,
    };
    byCode.set(s.code, cc);
    out.push(cc);
  });
  return out;
}

export const SEED_COST_CENTERS: CostCenter[] = build();

export const SEED_REQUIREMENT_RULES: CostCenterRequirementRule[] = [
  // Cost centers are an OPTIONAL management dimension by default. Mark P&L accounts
  // "required" only as an explicit entity policy (see the requirement-rules editor).
  { id: 'ccr_pl', entityId: PRIMARY_ENTITY_ID, accountTypeIds: ['INCOME', 'COST_OF_SALES', 'OPERATING_EXPENSE'], requirement: 'optional', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'ccr_bank', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_1251', 'seed_1252'], requirement: 'prohibited', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'ccr_tax', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_2270', 'seed_2260'], requirement: 'prohibited', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'ccr_ar_ap', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_1221', 'seed_2210'], requirement: 'optional', effectiveFrom: '2026-01-01', status: 'active' },
];
