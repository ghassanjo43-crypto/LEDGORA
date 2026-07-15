import type { CostCenter } from '@/types/costCenter';

/**
 * Cost-center hierarchy helpers: build the tree, detect cycles, move a node
 * (re-pathing descendants) and walk ancestors/descendants. A cost center has at
 * most one parent; circular parents are prohibited (§4).
 */

export interface CostCenterTreeNode extends CostCenter {
  children: CostCenterTreeNode[];
}

/** Build the parent/child tree, ordered by sortOrder then code. */
export function buildCostCenterTree(centers: CostCenter[]): CostCenterTreeNode[] {
  const byId = new Map<string, CostCenterTreeNode>();
  for (const c of centers) byId.set(c.id, { ...c, children: [] });
  const roots: CostCenterTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: CostCenterTreeNode[]): void => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** Flatten a tree into a depth-first list (used for indented pickers/lists). */
export function flattenCostCenterTree(nodes: CostCenterTreeNode[]): CostCenterTreeNode[] {
  const out: CostCenterTreeNode[] = [];
  const walk = (list: CostCenterTreeNode[]): void => {
    for (const n of list) { out.push(n); walk(n.children); }
  };
  walk(nodes);
  return out;
}

/** All descendant ids of a cost center (excluding itself). */
export function getCostCenterDescendants(centers: CostCenter[], id: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const c of centers) if (c.parentId) childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c.id]);
  const out: string[] = [];
  const walk = (cid: string): void => {
    for (const child of childrenOf.get(cid) ?? []) { out.push(child); walk(child); }
  };
  walk(id);
  return out;
}

/** Ancestor ids from the immediate parent up to the root. */
export function getCostCenterAncestors(centers: CostCenter[], id: string): string[] {
  const byId = new Map(centers.map((c) => [c.id, c]));
  const out: string[] = [];
  let current = byId.get(id)?.parentId;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    out.push(current);
    current = byId.get(current)?.parentId;
  }
  return out;
}

/** Would setting `parentId` on `id` create a cycle (parent is self or a descendant)? */
export function wouldCreateCycle(centers: CostCenter[], id: string, parentId: string | undefined): boolean {
  if (!parentId) return false;
  if (parentId === id) return true;
  return getCostCenterDescendants(centers, id).includes(parentId);
}

export interface HierarchyIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

/** Validate a proposed parent link (§4): entity match, no cycle, compatible dates. */
export function validateCostCenterHierarchy(centers: CostCenter[], center: CostCenter, parentId: string | undefined): HierarchyIssue[] {
  const issues: HierarchyIssue[] = [];
  if (!parentId) return issues;
  const parent = centers.find((c) => c.id === parentId);
  if (!parent) return [{ severity: 'error', rule: 'parent-missing', message: 'The selected parent cost center does not exist.' }];
  if (parent.entityId !== center.entityId) issues.push({ severity: 'error', rule: 'entity-mismatch', message: 'Parent and child cost centers must belong to the same entity.' });
  if (wouldCreateCycle(centers, center.id, parentId)) issues.push({ severity: 'error', rule: 'cycle', message: 'A cost center cannot be its own ancestor (circular hierarchy).' });
  if (parent.effectiveFrom > center.effectiveFrom) issues.push({ severity: 'warning', rule: 'date-compat', message: 'The parent becomes effective after this cost center — check effective dates.' });
  if (parent.effectiveTo && center.effectiveTo && parent.effectiveTo < center.effectiveTo) issues.push({ severity: 'warning', rule: 'date-compat-end', message: 'The parent expires before this cost center.' });
  return issues;
}

/**
 * Move a cost center under a new parent and re-path all descendants. Returns the
 * updated center list (does not mutate). Blocks cycles by returning the input
 * unchanged when the move is invalid.
 */
export function moveCostCenter(centers: CostCenter[], id: string, newParentId: string | undefined): { centers: CostCenter[]; ok: boolean; error?: string } {
  if (wouldCreateCycle(centers, id, newParentId)) return { centers, ok: false, error: 'That move would create a circular hierarchy.' };
  const byId = new Map(centers.map((c) => [c.id, { ...c }]));
  const node = byId.get(id);
  if (!node) return { centers, ok: false, error: 'Cost center not found.' };
  const newParent = newParentId ? byId.get(newParentId) : undefined;
  if (newParentId && newParent && newParent.entityId !== node.entityId) return { centers, ok: false, error: 'Cannot move a cost center to a different entity.' };

  node.parentId = newParentId;

  // Re-path node then every descendant, top-down.
  const repath = (cid: string): void => {
    const c = byId.get(cid)!;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    c.hierarchyPath = parent ? [...parent.hierarchyPath, c.id] : [c.id];
    c.level = parent ? parent.level + 1 : 0;
    for (const child of centers.filter((x) => x.parentId === cid)) repath(child.id);
  };
  repath(id);
  return { centers: [...byId.values()], ok: true };
}

/** A cost center is usable on a date when active and within its effective window (§7). */
export function isCostCenterActiveOnDate(center: CostCenter | undefined, date: string): boolean {
  if (!center) return false;
  if (center.status !== 'active') return false;
  if (center.effectiveFrom > date) return false;
  if (center.effectiveTo && center.effectiveTo < date) return false;
  return true;
}

/** Case-insensitive duplicate-code check within an entity (§6). */
export function checkDuplicateCostCenterCode(centers: CostCenter[], code: string, entityId: string, excludeId?: string): boolean {
  const norm = code.trim().toLowerCase();
  return centers.some((c) => c.id !== excludeId && c.entityId === entityId && c.code.trim().toLowerCase() === norm);
}
