import type { Project, ProjectRequirementRule } from '@/types/project';

/** Default sample projects (data only). */
const TS = new Date('2026-01-01T00:00:00.000Z').toISOString();
export const PRIMARY_ENTITY_ID = 'primary';

interface Spec { code: string; name: string; status?: Project['status']; start?: string; end?: string; budget?: number; contract?: number; estCost?: number; recognition?: Project['revenueRecognitionMethod']; billing?: Project['billingMethod']; }

const SPECS: Spec[] = [
  { code: 'PRJ-SOLAR', name: 'Solar Plant Installation', status: 'active', start: '2026-01-01', budget: 250000, contract: 300000, estCost: 220000, recognition: 'percentage-of-completion', billing: 'milestone' },
  { code: 'PRJ-ERP', name: 'ERP Rollout', status: 'active', start: '2026-02-01', budget: 120000, contract: 150000, estCost: 110000, recognition: 'invoice', billing: 'time-and-materials' },
  { code: 'PRJ-RND', name: 'R&D — Battery Storage', status: 'planning', start: '2026-03-01', budget: 80000, estCost: 80000, recognition: 'cost-recovery', billing: 'cost-plus' },
  { code: 'PRJ-OFFICE', name: 'Office Fit-out', status: 'completed', start: '2025-09-01', end: '2026-01-15', budget: 60000, contract: 65000, estCost: 58000, recognition: 'invoice', billing: 'fixed-price' },
];

/**
 * Default project requirement rules. The project dimension is OPTIONAL on P&L by
 * default and PROHIBITED on bank/cash, receivables, payables and tax control
 * accounts. An entity may make revenue/direct-cost accounts required via the rules.
 */
export const SEED_PROJECT_REQUIREMENT_RULES: ProjectRequirementRule[] = [
  { id: 'prr_pl', entityId: PRIMARY_ENTITY_ID, accountTypeIds: ['INCOME', 'COST_OF_SALES', 'OPERATING_EXPENSE'], requirement: 'optional', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'prr_bank', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_1251', 'seed_1252'], requirement: 'prohibited', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'prr_ar', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_1221'], requirement: 'prohibited', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'prr_ap', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_2210'], requirement: 'prohibited', effectiveFrom: '2026-01-01', status: 'active' },
  { id: 'prr_tax', entityId: PRIMARY_ENTITY_ID, accountIds: ['seed_2270', 'seed_2260'], requirement: 'prohibited', effectiveFrom: '2026-01-01', status: 'active' },
];

export const SEED_PROJECTS: Project[] = SPECS.map((s) => ({
  id: `prj_${s.code}`, entityId: PRIMARY_ENTITY_ID, code: s.code, name: s.name,
  status: s.status ?? 'active', startDate: s.start ?? '2026-01-01', endDate: s.end,
  budgetAmount: s.budget, currencyCode: 'USD', isBillable: true,
  contractValue: s.contract, estimatedTotalCost: s.estCost, revenueRecognitionMethod: s.recognition, billingMethod: s.billing, markupPercent: s.billing === 'cost-plus' ? 15 : undefined,
  changeOrders: [], milestones: [],
  auditTrail: [{ id: `paud_${s.code}`, at: TS, action: 'project-created', detail: 'seed' }],
  createdAt: TS, updatedAt: TS,
}));
