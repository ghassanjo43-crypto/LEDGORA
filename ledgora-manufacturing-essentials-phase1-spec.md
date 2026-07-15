# Ledgora Manufacturing Essentials — Phase 1

## Objective

Enable the first working manufacturing components under the Ledgora Manufacturing edition.

This phase builds on the existing:

- Accounting engine
- General Journal and General Ledger
- Inventory module
- Item master
- Warehouses
- Weighted-average and standard-cost foundations
- Cost centers
- Projects, where separately enabled
- Entitlement framework
- React + TypeScript
- Zustand + LocalStorage

Do not create a second stock ledger, valuation engine, or accounting engine.

Core rule:

```text
Inventory owns stock.
Manufacturing owns production workflow.
General Journal owns accounting.
```

---

## 1. Phase 1 Scope

Implement now:

1. Manufacturing settings
2. Plants
3. Production lines
4. Work centers
5. Bills of Materials
6. Routings
7. Work orders
8. Material requirements
9. Material issues
10. Material returns
11. Production receipts
12. Basic scrap
13. Work-in-progress accounting
14. Standard manufacturing cost
15. Actual work-order cost
16. Basic variance analysis
17. Manufacturing dashboard
18. Manufacturing reports
19. Entitlement and route gating
20. Edition-specific seed data
21. Automated tests

Defer:

- Full MRP
- Demand forecasting
- Capacity planning
- Advanced scheduling
- Quality management
- Maintenance
- Subcontract manufacturing
- Process manufacturing
- Yield and co-products
- Advanced overhead allocation
- Barcode/mobile shop-floor workflows

---

## 2. Entitlements

Enable these modules:

```ts
type LedgoraModule =
  | ...
  | "manufacturing_core"
  | "manufacturing_items"
  | "manufacturing_bom"
  | "manufacturing_routings"
  | "manufacturing_work_centers"
  | "manufacturing_work_orders"
  | "manufacturing_material_issues"
  | "manufacturing_production_receipts"
  | "manufacturing_scrap"
  | "manufacturing_standard_costing"
  | "manufacturing_actual_costing"
  | "manufacturing_variance_analysis"
  | "manufacturing_dashboards"
  | "manufacturing_reports"
```

Dependencies:

```text
manufacturing_core requires:
- core_accounting
- inventory_basic
- warehouses
- cost_centers

manufacturing_items requires:
- manufacturing_core
- inventory_basic

manufacturing_bom requires:
- manufacturing_items

manufacturing_routings requires:
- manufacturing_core

manufacturing_work_centers requires:
- manufacturing_core
- cost_centers

manufacturing_work_orders requires:
- manufacturing_bom
- manufacturing_routings
- manufacturing_work_centers
- inventory_basic
- warehouses

manufacturing_material_issues requires:
- manufacturing_work_orders
- inventory_basic
- warehouses

manufacturing_production_receipts requires:
- manufacturing_work_orders
- inventory_basic
- warehouses

manufacturing_scrap requires:
- manufacturing_work_orders

manufacturing_standard_costing requires:
- manufacturing_bom
- manufacturing_routings
- manufacturing_work_centers

manufacturing_actual_costing requires:
- manufacturing_work_orders
- manufacturing_material_issues
- manufacturing_production_receipts
- core_accounting

manufacturing_variance_analysis requires:
- manufacturing_standard_costing
- manufacturing_actual_costing
```

Manufacturing routes must remain blocked if Inventory is absent.

---

## 3. Navigation

When Manufacturing is enabled, show:

```text
Manufacturing
- Dashboard
- Plants
- Production Lines
- Work Centers
- Bills of Materials
- Routings
- Work Orders
- Material Issues
- Material Returns
- Production Receipts
- Scrap
- Product Costing
- Manufacturing Reports
```

Do not expose unfinished MRP, Quality, Maintenance, or Process Manufacturing pages.

---

## 4. Manufacturing Settings

```ts
export type ManufacturingSettings = {
  entityId: string

  enabled: boolean

  defaultRawMaterialWarehouseId?: string
  defaultWipWarehouseId?: string
  defaultFinishedGoodsWarehouseId?: string
  defaultScrapWarehouseId?: string

  defaultWipAccountId?: string
  defaultLaborAbsorptionAccountId?: string
  defaultMachineAbsorptionAccountId?: string
  defaultOverheadAbsorptionAccountId?: string
  defaultVarianceAccountId?: string
  defaultScrapExpenseAccountId?: string

  workOrderPrefix: string
  materialIssuePrefix: string
  materialReturnPrefix: string
  productionReceiptPrefix: string
  scrapPrefix: string

  costingPolicy: "standard" | "actual"

  allowPartialCompletion: boolean
  allowOverproduction: boolean
  allowMaterialOverIssue: boolean

  createdAt: string
  updatedAt: string
}
```

Recommended defaults:

```text
costingPolicy = standard
allowPartialCompletion = true
allowOverproduction = false
allowMaterialOverIssue = false
```

---

## 5. Plants

```ts
export type ManufacturingPlant = {
  id: string
  entityId: string

  code: string
  name: string
  description?: string
  address?: string
  managerName?: string

  defaultCostCenterId?: string

  rawMaterialWarehouseId?: string
  wipWarehouseId?: string
  finishedGoodsWarehouseId?: string
  scrapWarehouseId?: string

  status: "active" | "inactive" | "archived"

  createdAt: string
  updatedAt: string
}
```

Rules:

- Plant code unique by entity.
- Referenced plants cannot be deleted.
- Archived plants remain historically visible.
- Plant defaults do not replace transaction-level dimensions.

---

## 6. Production Lines

```ts
export type ProductionLine = {
  id: string
  entityId: string
  plantId: string

  code: string
  name: string
  description?: string

  defaultCostCenterId?: string

  dailyCapacity?: number
  capacityUnitId?: string

  status: "active" | "inactive" | "archived"

  createdAt: string
  updatedAt: string
}
```

Production line is an operational dimension, not an account or warehouse.

---

## 7. Work Centers

```ts
export type WorkCenter = {
  id: string
  entityId: string
  plantId: string
  productionLineId?: string

  code: string
  name: string
  description?: string

  type:
    | "labor"
    | "machine"
    | "assembly"
    | "inspection"
    | "packaging"
    | "mixed"

  costCenterId: string

  availableHoursPerDay: number
  efficiencyPercent: number

  setupRatePerHour: number
  laborRatePerHour: number
  machineRatePerHour: number
  overheadRatePerHour: number

  status: "active" | "inactive" | "archived"

  createdAt: string
  updatedAt: string
}
```

Rules:

- Work-center code unique by entity.
- Cost center is mandatory.
- Rates are snapshotted into released work orders.
- Later rate changes do not rewrite history.

---

## 8. Manufacturing Items

Use the existing Inventory item master.

Manufacturable items:

```text
isInventoryTracked = true
isManufacturable = true
itemType:
- subassembly
- finished-good
```

BOM components may be:

```text
raw-material
component
subassembly
packaging
consumable
```

Add optional fields to the existing item type:

```ts
preferredBomId?: string
preferredRoutingId?: string
defaultPlantId?: string
defaultProductionLineId?: string
defaultBatchSize?: number
minimumBatchSize?: number
maximumBatchSize?: number
```

Do not create a separate Manufacturing item table.

---

## 9. Bill of Materials

```ts
export type BomStatus =
  | "draft"
  | "approved"
  | "inactive"
  | "archived"

export type BillOfMaterials = {
  id: string
  entityId: string

  code: string
  name: string
  productItemId: string

  version: number
  revisionLabel?: string

  status: BomStatus

  effectiveFrom: string
  effectiveTo?: string

  outputQuantity: number
  outputUnitId: string

  expectedYieldPercent: number
  expectedScrapPercent?: number

  components: BomComponent[]

  notes?: string

  approvedAt?: string
  approvedBy?: string

  createdAt: string
  updatedAt: string
}
```

```ts
export type BomComponent = {
  id: string
  bomId: string

  sequence: number
  itemId: string

  quantity: number
  unitId: string
  quantityPerOutput: number

  expectedScrapPercent?: number
  issueWarehouseId?: string

  isOptional: boolean
  substituteItemIds?: string[]

  notes?: string
}
```

Rules:

- Approved BOMs are immutable.
- Editing an approved BOM creates a new version.
- Output and component quantities must be positive.
- Prevent circular BOM references.
- Historical work orders retain the exact BOM snapshot.
- Phase 1 must support one-level BOM reliably.
- Subassembly support may be prepared but must not create unsafe recursive logic.

---

## 10. Routings

```ts
export type RoutingStatus =
  | "draft"
  | "approved"
  | "inactive"
  | "archived"

export type ManufacturingRouting = {
  id: string
  entityId: string

  code: string
  name: string
  productItemId: string

  version: number
  revisionLabel?: string

  status: RoutingStatus

  effectiveFrom: string
  effectiveTo?: string

  operations: RoutingOperation[]

  notes?: string

  approvedAt?: string
  approvedBy?: string

  createdAt: string
  updatedAt: string
}
```

```ts
export type RoutingOperation = {
  id: string
  routingId: string

  operationNumber: number
  name: string
  description?: string

  workCenterId: string

  setupHours: number
  runHoursPerUnit: number
  queueHours?: number

  requiresInspection: boolean
  isOutsourced: boolean

  notes?: string
}
```

Rules:

- Operation number unique within routing.
- Approved routing is immutable.
- Released work order stores operation and rate snapshots.

---

## 11. Standard Cost

Create:

```ts
calculateStandardManufacturingCost({
  item,
  bom,
  routing,
  outputQuantity,
  asOf,
})
```

Cost formula:

```text
Material cost
+ Direct labor
+ Machine cost
+ Production overhead
+ Expected normal scrap
= Standard manufacturing cost
```

```ts
export type ManufacturingCostBreakdown = {
  itemId: string
  outputQuantity: number

  materialCost: number
  laborCost: number
  machineCost: number
  overheadCost: number
  expectedScrapCost: number

  totalCost: number
  unitCost: number

  bomVersion: number
  routingVersion: number

  calculatedAt: string
}
```

Create effective-dated versions:

```ts
export type StandardCostVersion = {
  id: string
  entityId: string
  itemId: string

  effectiveFrom: string
  effectiveTo?: string

  breakdown: ManufacturingCostBreakdown

  status: "draft" | "active" | "superseded"

  createdAt: string
  createdBy?: string
}
```

Do not silently overwrite item standard cost.

---

## 12. Work Orders

```ts
export type WorkOrderStatus =
  | "draft"
  | "planned"
  | "released"
  | "in-progress"
  | "partially-completed"
  | "completed"
  | "closed"
  | "on-hold"
  | "cancelled"

export type ManufacturingWorkOrder = {
  id: string
  entityId: string

  workOrderNumber: string

  plantId: string
  productionLineId?: string

  productItemId: string

  bomId: string
  bomVersion: number

  routingId: string
  routingVersion: number

  plannedQuantity: number
  completedQuantity: number
  scrappedQuantity: number

  unitId: string

  plannedStartDate: string
  plannedEndDate: string

  actualStartDate?: string
  actualEndDate?: string

  rawMaterialWarehouseId: string
  wipWarehouseId: string
  finishedGoodsWarehouseId: string
  scrapWarehouseId?: string

  costCenterId: string
  projectId?: string

  status: WorkOrderStatus

  materialRequirements: WorkOrderMaterialRequirement[]
  operationSnapshots: WorkOrderOperationSnapshot[]

  standardCostSnapshot: ManufacturingCostBreakdown

  notes?: string

  createdAt: string
  updatedAt: string

  releasedAt?: string
  releasedBy?: string

  closedAt?: string
  closedBy?: string
}
```

Numbering:

```text
WO-YYYY-####
```

Entity-specific and never reused.

---

## 13. Material Requirements

```ts
export type WorkOrderMaterialRequirement = {
  id: string
  workOrderId: string

  itemId: string

  requiredQuantity: number
  issuedQuantity: number
  returnedQuantity: number

  unitId: string
  warehouseId: string

  standardUnitCostSnapshot: number

  bomComponentSnapshot: {
    itemCode: string
    itemName: string
    quantityPerOutput: number
    expectedScrapPercent?: number
  }
}
```

At release:

```text
Required quantity
=
BOM quantity per output
× planned output
adjusted for expected normal scrap
```

Released requirements are snapshots.

---

## 14. Operation Snapshots

```ts
export type WorkOrderOperationSnapshot = {
  id: string
  workOrderId: string

  operationNumber: number
  name: string

  workCenterId: string
  workCenterCode: string
  workCenterName: string

  plannedSetupHours: number
  plannedRunHours: number

  actualSetupHours: number
  actualRunHours: number

  laborRateSnapshot: number
  machineRateSnapshot: number
  overheadRateSnapshot: number

  status:
    | "not-started"
    | "in-progress"
    | "completed"
    | "skipped"
}
```

Phase 1 may use manual actual-hour entry.

---

## 15. Work-Order Lifecycle

Allowed:

```text
Draft
→ Planned
→ Released
→ In Progress
→ Partially Completed
→ Completed
→ Closed
```

Also:

```text
Planned/Released/In Progress → On Hold
On Hold → Released/In Progress
Draft/Planned → Cancelled
```

Rules:

- Release snapshots BOM, routing, rates, warehouses, and dimensions.
- Cancel only if no posted movements exist.
- Closed work orders accept no further production activity.
- Closeout requires WIP and quantity reconciliation.

---

## 16. Material Issue

```ts
export type ManufacturingMaterialIssue = {
  id: string
  entityId: string

  issueNumber: string
  workOrderId: string

  issueDate: string
  postingDate: string

  lines: ManufacturingMaterialIssueLine[]

  status: "draft" | "posted" | "reversed"

  journalEntryId?: string

  createdAt: string
  updatedAt: string
}
```

Each line stores:

```ts
itemId
requirementId?
quantity
unitId
sourceWarehouseId
stockMovementId?
unitCostSnapshot?
totalCostSnapshot?
costCenterId
projectId?
```

Posting:

```text
Dr Work in Progress
    Cr Raw-Material Inventory
```

Requirements:

- Use Inventory valuation for outbound cost.
- Create `manufacturing-material-issue` stock movement.
- Block insufficient stock.
- Block over-issue unless policy allows.
- Stock movement and journal entry must be atomic.
- Preserve all snapshots.

---

## 17. Material Return

Unused material return:

```text
Dr Raw-Material Inventory
    Cr Work in Progress
```

Use original issue cost where possible.

Prevent return above net issued quantity.

---

## 18. Production Receipt

```ts
export type ManufacturingProductionReceipt = {
  id: string
  entityId: string

  receiptNumber: string
  workOrderId: string

  receiptDate: string
  postingDate: string

  finishedGoodsWarehouseId: string
  wipWarehouseId: string

  completedQuantity: number
  unitId: string

  status: "draft" | "posted" | "reversed"

  stockMovementId?: string
  journalEntryId?: string

  costSnapshot: {
    costingPolicy: "standard" | "actual"
    unitCost: number
    totalCost: number
  }

  createdAt: string
  updatedAt: string
}
```

Posting:

```text
Dr Finished-Goods Inventory
    Cr Work in Progress
```

Rules:

- Create `manufacturing-production-receipt` stock movement.
- Partial receipts allowed when configured.
- Overproduction blocked by default.
- Completed quantity is derived from posted receipts.
- Reversal uses original receipt cost.

---

## 19. Work in Progress

WIP must derive from posted activity:

```text
Materials issued
- Materials returned
+ Labor absorbed
+ Machine absorbed
+ Overhead absorbed
- Finished goods received
- Recoverable scrap
= Remaining WIP
```

Create:

```ts
getWorkOrderWipBalance(...)
getManufacturingWipByWorkOrder(...)
getManufacturingWipByPlant(...)
getManufacturingWipAsOf(...)
```

Do not store a competing mutable WIP total.

---

## 20. Operation Cost Entry

Phase 1 may support manual actual hours:

```ts
export type WorkOrderOperationCostEntry = {
  id: string
  workOrderId: string
  operationSnapshotId: string

  postingDate: string

  setupHours: number
  runHours: number

  laborCost: number
  machineCost: number
  overheadCost: number

  journalEntryId?: string

  status: "posted" | "reversed"

  createdAt: string
}
```

Posting:

```text
Dr Work in Progress
    Cr Labor Absorption
```

```text
Dr Work in Progress
    Cr Machine Absorption
```

```text
Dr Work in Progress
    Cr Manufacturing Overhead Absorbed
```

Do not fake absorption if balanced journal posting is not implemented.

---

## 21. Scrap

```ts
export type ManufacturingScrap = {
  id: string
  entityId: string

  scrapNumber: string
  workOrderId: string

  scrapDate: string
  postingDate: string

  itemId: string
  quantity: number
  unitId: string

  reason:
    | "normal-process-loss"
    | "damage"
    | "quality-failure"
    | "machine-failure"
    | "operator-error"
    | "other"

  accountingPolicy:
    | "normal-to-product-cost"
    | "abnormal-to-expense"

  recoverableValue?: number
  scrapWarehouseId?: string

  status: "draft" | "posted" | "reversed"

  journalEntryId?: string
  stockMovementId?: string

  createdAt: string
  updatedAt: string
}
```

Abnormal scrap:

```text
Dr Scrap Expense
    Cr Work in Progress
```

Recoverable scrap:

```text
Dr Scrap Inventory
    Cr Work in Progress
```

---

## 22. Actual Work-Order Cost

Create:

```ts
calculateActualWorkOrderCost(workOrderId)
```

Derive from posted records:

```text
Material issues
- Material returns
+ Labor
+ Machine
+ Overhead
+ Other authorized production costs
- Recoverable scrap
= Actual work-order cost
```

```ts
export type ActualWorkOrderCost = {
  workOrderId: string

  materialCost: number
  laborCost: number
  machineCost: number
  overheadCost: number
  scrapCost: number
  otherCost: number

  totalCost: number

  completedQuantity: number
  costPerCompletedUnit?: number

  asOf: string
}
```

Do not store an unrelated authoritative actual-cost total.

---

## 23. Variance Analysis

Basic variance:

```text
Actual cost for completed output
-
Standard cost for completed output
=
Manufacturing variance
```

```ts
export type ManufacturingVariance = {
  workOrderId: string

  standardCostForOutput: number
  actualCostForOutput: number

  materialUsageVariance?: number
  materialPriceVariance?: number
  laborVariance?: number
  machineVariance?: number
  overheadVariance?: number
  scrapVariance?: number

  totalVariance: number

  calculatedAt: string
}
```

Phase 1 may report variance without automatic variance journal posting.

---

## 24. Closeout

Before closing a work order:

- No open draft material issues
- No open draft production receipts
- Completed quantity reviewed
- Scrap reviewed
- Material issue/return quantities reconciled
- WIP balance reviewed
- Variance calculated
- No invalid negative WIP

Closeout report:

```text
Planned output
Completed output
Scrap
Required material
Issued material
Returned material
Material variance
Standard cost
Actual cost
Total variance
Remaining WIP
```

Final closeout is snapshotted.

---

## 25. Dashboard

Show:

- Open work orders
- Released work orders
- In-progress work orders
- Due today
- Overdue
- Planned output
- Completed output
- Completion rate
- Material shortages
- Raw-material value
- WIP value
- Finished-goods value
- Scrap quantity/value
- Standard cost
- Actual cost
- Variance
- Top overdue work orders
- Top unfavorable variances

Do not show widgets for deferred modules.

---

## 26. Reports

Required:

1. Work Order Register
2. Work Order Status
3. Work Order Cost
4. Standard vs Actual Cost
5. Material Requirements
6. Material Issue Register
7. Material Return Register
8. Production Receipt Register
9. WIP by Work Order
10. WIP by Plant
11. WIP as of Date
12. Scrap Register
13. Production Plan vs Actual
14. Work Center Cost Summary
15. Manufacturing Variance Summary
16. Product Standard Cost
17. BOM Cost Rollup
18. Routing Cost
19. Manufacturing-to-GL Reconciliation

All accounting values must drill down to journals and stock movements.

---

## 27. GL Reconciliation

Compare manufacturing subledger to:

- Raw-material inventory
- WIP
- Finished-goods inventory
- Labor absorption
- Machine absorption
- Overhead absorption
- Scrap expense
- Manufacturing variance

Filters:

- Entity
- Plant
- Work order
- Account
- As-of date

Show differences explicitly.

---

## 28. Inventory Integration

All manufacturing stock flows must call the shared Inventory services.

Use:

```ts
postStockMovement(...)
getInventoryBalance(...)
validateAvailableStock(...)
reverseStockMovement(...)
```

Never duplicate:

- Quantity on hand
- Warehouse balances
- Inventory valuation
- Stock movement history

Manufacturing metadata may be added to Inventory movements:

```ts
manufacturingWorkOrderId?: string
manufacturingOperationId?: string
manufacturingBatchId?: string
```

---

## 29. Cost Centers and Projects

Cost centers:

- Plant may default a cost center.
- Work center requires cost center.
- Work order snapshots cost center.
- WIP debit lines may carry cost center.
- Scrap expense carries responsible cost center.

Projects remain optional:

- R&D
- Customer-specific manufacturing
- Capital project
- Tooling

Project does not replace plant, warehouse, work center, or cost center.

---

## 30. Posting Atomicity

Create:

```ts
postManufacturingMaterialIssue(...)
postManufacturingMaterialReturn(...)
postManufacturingProductionReceipt(...)
postManufacturingOperationCost(...)
postManufacturingScrap(...)
```

Each must commit atomically:

- Manufacturing document
- Inventory movement
- Journal entry
- Work-order quantities
- Audit event

No partial posting may remain after failure.

---

## 31. Reversal

Posted manufacturing documents are immutable.

Reversal must:

- Create opposite Inventory movement
- Reverse original journal entry
- Restore issued/completed/scrap quantities
- Use original cost
- Link original and reversal
- Preserve audit history

Block invalid reversals where later activity depends on the original movement.

---

## 32. Store and Files

Recommended store:

```text
src/store/manufacturingStore.ts
```

Recommended files:

```text
src/types/manufacturing.ts
src/types/manufacturingDocuments.ts
src/types/manufacturingCosting.ts

src/lib/manufacturingValidation.ts
src/lib/bomVersioning.ts
src/lib/routingVersioning.ts
src/lib/workOrderLifecycle.ts
src/lib/workOrderRequirements.ts
src/lib/manufacturingCosting.ts
src/lib/manufacturingPosting.ts
src/lib/manufacturingReversal.ts
src/lib/manufacturingReconciliation.ts
src/lib/manufacturingNumbering.ts
src/lib/manufacturingSeed.ts

src/components/manufacturing/
  PlantEditor.tsx
  ProductionLineEditor.tsx
  WorkCenterEditor.tsx
  BomEditor.tsx
  RoutingEditor.tsx
  WorkOrderEditor.tsx
  MaterialIssueEditor.tsx
  MaterialReturnEditor.tsx
  ProductionReceiptEditor.tsx
  ScrapEditor.tsx
  WorkOrderCostPanel.tsx

src/pages/
  ManufacturingDashboardPage.tsx
  PlantsPage.tsx
  ProductionLinesPage.tsx
  WorkCentersPage.tsx
  BillsOfMaterialsPage.tsx
  RoutingsPage.tsx
  WorkOrdersPage.tsx
  MaterialIssuesPage.tsx
  MaterialReturnsPage.tsx
  ProductionReceiptsPage.tsx
  ManufacturingScrapPage.tsx
  ProductCostingPage.tsx
  ManufacturingReportsPage.tsx
```

Modify:

- Entitlement registry
- Manufacturing edition preset
- Navigation
- Routes
- Dashboard registry
- Global search
- Inventory movement metadata
- Journal posting
- Cost-center reports
- Project reports where enabled
- Seed initialization

---

## 33. Seed Data

Manufacturing edition only:

- PLANT-01
- RM-WH
- WIP-WH
- FG-WH
- SCRAP-WH
- LINE-01
- CUT-01
- ASM-01
- PACK-01
- RM-STEEL
- RM-BOLT
- RM-PAINT
- FG-CABINET
- One approved BOM
- One approved routing
- One planned work order
- One released work order
- One material issue
- One partial production receipt
- One scrap record
- One active standard-cost version

Do not seed this into other editions.

---

## 34. Acceptance Scenario

Finished item:

```text
FG-CABINET
Planned output: 10 units
```

BOM per unit:

```text
Steel: 2 × 20 = 40
Bolts: 4 × 1 = 4
Paint: 1 × 5 = 5
Material = 49
```

Routing per unit:

```text
Labor = 8
Machine = 4
Overhead = 3
Conversion = 15
```

Standard unit cost:

```text
49 + 15 = 64
```

Planned standard cost:

```text
10 × 64 = 640
```

Material issue:

```text
Dr WIP 490
    Cr Raw-Material Inventory 490
```

Conversion:

```text
Dr WIP 150
    Cr Labor/Machine/Overhead Absorption 150
```

Production receipt:

```text
Dr Finished-Goods Inventory 640
    Cr WIP 640
```

Expected:

- Raw materials decrease
- WIP reconciles
- Finished goods increase
- Journals balance
- Inventory subledger reconciles to GL
- Work order completes
- Standard cost remains snapshotted

---

## 35. Tests

Add tests for:

1. Manufacturing hidden without entitlement
2. Manufacturing visible with entitlement
3. Inventory dependency
4. Protected routes
5. Navigation filtering
6. Search filtering
7. Seed isolation
8. Unique plant code
9. Unique production-line code
10. Unique work-center code
11. Work center requires cost center
12. BOM creation and approval
13. Approved BOM immutable
14. New BOM version
15. Circular BOM blocked
16. Routing approval
17. Rate snapshots
18. Material cost rollup
19. Routing cost rollup
20. Standard cost
21. Standard-cost versioning
22. Draft-to-planned
23. Planned-to-released
24. Release snapshots
25. Material requirements
26. Invalid lifecycle transition
27. Cancellation rules
28. Material issue
29. Insufficient stock blocked
30. Over-issue blocked
31. Material return
32. Partial production receipt
33. Overproduction blocked
34. Scrap posting
35. WIP calculation
36. Actual cost
37. Variance calculation
38. Atomic rollback
39. Exact reversal
40. Reversal uses original cost
41. Material-issue journal
42. Production-receipt journal
43. Scrap journal
44. Cost-center snapshot
45. Optional project
46. No tax on internal movements
47. Manufacturing-to-GL reconciliation
48. Inventory-to-GL reconciliation
49. LocalStorage hydration
50. Store migration
51. Stable Zustand selectors
52. Downgrade preserves history

---

## 36. QA

Run:

- `tsc --noEmit`
- Full test suite
- Production build
- No-Manufacturing smoke test
- Manufacturing entitlement smoke test
- Inventory dependency test
- Plant/work-center tests
- BOM/routing tests
- Work-order lifecycle test
- Material issue/return tests
- Production receipt test
- Scrap test
- Standard-cost test
- Actual-cost test
- Variance test
- WIP reconciliation test
- Inventory-to-GL reconciliation
- Manufacturing-to-GL reconciliation
- Navigation/route/search tests
- LocalStorage migration test
- Selector-safety scan
- Clean dev-server restart

Report:

- Files created
- Files modified
- Entitlement behavior
- Plants and work centers
- BOM and routing versioning
- Work-order lifecycle
- Inventory integration
- WIP accounting
- Standard and actual costing
- Variance behavior
- Reports and reconciliation
- Tests
- Typecheck
- Production build
- Deferred work

---

## Final Principle

```text
BOM and Routing
→ Work Order
→ Material Issue
→ Inventory Movement
→ WIP Journal
→ Production Receipt
→ Finished-Goods Inventory
→ Manufacturing Reports
```

No manufacturing component may maintain a competing stock balance or accounting ledger.
