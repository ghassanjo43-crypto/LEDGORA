# Ledgora Manufacturing Edition — Entitlement Architecture Amendment

## Purpose

Extend the existing Ledgora editions and module-entitlement architecture to include a dedicated edition for manufacturing plants.

Ledgora must now support:

```text
Ledgora Core
Ledgora Projects
Ledgora Construction
Ledgora Manufacturing
Ledgora Enterprise
```

The Manufacturing edition must use the same:

- Codebase
- Accounting engine
- General Journal
- General Ledger
- Chart of Accounts
- Sales and purchase modules
- Customers and suppliers
- Tax and currency engines
- Cost-center framework
- Subscription and entitlement framework
- Zustand and LocalStorage architecture
- Validation and reporting infrastructure

Do not create a separate manufacturing application.

Do not force manufacturing modules on Core, Projects, or Construction customers.

---

# 1. Update Edition Type

Change:

```ts
export type LedgoraEdition =
  | "core"
  | "projects"
  | "construction"
  | "enterprise"
```

to:

```ts
export type LedgoraEdition =
  | "core"
  | "projects"
  | "construction"
  | "manufacturing"
  | "enterprise"
```

---

# 2. Commercial Positioning

## Ledgora Manufacturing

Recommended positioning:

> Manufacturing accounting, production control, inventory costing, and plant performance from one reliable ledger.

Recommended tagline:

> From raw material to finished product—complete financial control of every production stage.

Alternative taglines:

- Plan production. Control cost. Protect margin.
- Every material. Every machine. Every cost. One reliable ledger.
- Manufacturing control without enterprise ERP complexity.
- Know the true cost of every product and production run.

---

# 3. Target Customers

Ledgora Manufacturing should serve:

- Discrete manufacturing plants
- Assembly operations
- Food production
- Pharmaceutical manufacturing
- Chemical manufacturing
- Packaging plants
- Metal fabrication
- Plastics production
- Furniture manufacturing
- Garment and textile factories
- Electronics assembly
- Building-material manufacturers
- Industrial equipment manufacturers
- Contract manufacturers
- Small and medium-sized production facilities

The first release should support a general manufacturing foundation.

Later add-ons may specialize for:

- Discrete manufacturing
- Process manufacturing
- Batch manufacturing
- Food and beverage
- Pharmaceutical and regulated manufacturing

---

# 4. Edition Composition

The Manufacturing edition should not automatically include every Projects feature.

Recommended composition:

```text
Ledgora Manufacturing
=
Ledgora Core
+ Cost Centers
+ Inventory
+ Warehouses
+ Manufacturing Core
+ Product Costing
+ Production Planning
+ Work Orders
+ Quality
+ Maintenance
```

Project accounting remains an optional add-on unless the manufacturing company also operates through projects or customer contracts.

This prevents the Manufacturing edition from becoming unnecessarily expensive or complex.

---

# 5. Add Manufacturing Modules to Registry

Add:

```ts
export type LedgoraModule =
  | ...
  | "inventory_basic"
  | "inventory_advanced"
  | "warehouses"
  | "lot_serial_tracking"
  | "landed_cost"
  | "manufacturing_core"
  | "manufacturing_items"
  | "manufacturing_bom"
  | "manufacturing_routings"
  | "manufacturing_work_centers"
  | "manufacturing_work_orders"
  | "manufacturing_production_planning"
  | "manufacturing_mrp"
  | "manufacturing_capacity_planning"
  | "manufacturing_material_issues"
  | "manufacturing_production_receipts"
  | "manufacturing_scrap"
  | "manufacturing_rework"
  | "manufacturing_subcontracting"
  | "manufacturing_standard_costing"
  | "manufacturing_actual_costing"
  | "manufacturing_variance_analysis"
  | "manufacturing_quality"
  | "manufacturing_maintenance"
  | "manufacturing_traceability"
  | "manufacturing_batch_process"
  | "manufacturing_yield"
  | "manufacturing_co_products"
  | "manufacturing_dashboards"
  | "manufacturing_reports"
```

---

# 6. Manufacturing Module Categories

Add module category:

```ts
category:
  | "core"
  | "sales"
  | "purchases"
  | "projects"
  | "construction"
  | "manufacturing"
  | "reporting"
  | "administration"
```

---

# 7. Manufacturing Edition Preset

Add a manufacturing preset to `EDITION_MODULES`.

Recommended first-release preset:

```ts
manufacturing: [
  ...CORE_MODULES,

  "cost_centers",

  "inventory_basic",
  "inventory_advanced",
  "warehouses",
  "lot_serial_tracking",
  "landed_cost",

  "manufacturing_core",
  "manufacturing_items",
  "manufacturing_bom",
  "manufacturing_routings",
  "manufacturing_work_centers",
  "manufacturing_work_orders",
  "manufacturing_production_planning",
  "manufacturing_mrp",
  "manufacturing_material_issues",
  "manufacturing_production_receipts",
  "manufacturing_scrap",
  "manufacturing_standard_costing",
  "manufacturing_actual_costing",
  "manufacturing_variance_analysis",
  "manufacturing_quality",
  "manufacturing_maintenance",
  "manufacturing_traceability",
  "manufacturing_dashboards",
  "manufacturing_reports",
]
```

Recommended optional add-ons:

```text
Project Accounting
Advanced Capacity Planning
Subcontract Manufacturing
Batch and Process Manufacturing
Yield and Co-Products
Advanced Quality
Advanced Maintenance
Advanced Reporting
Multi-Entity
Approvals
```

---

# 8. Dependency Rules

Add dependencies:

```text
inventory_advanced requires inventory_basic
warehouses requires inventory_basic
lot_serial_tracking requires inventory_basic
landed_cost requires inventory_basic and purchases

manufacturing_core requires core_accounting and inventory_basic
manufacturing_items requires manufacturing_core
manufacturing_bom requires manufacturing_items
manufacturing_routings requires manufacturing_core
manufacturing_work_centers requires manufacturing_core

manufacturing_work_orders requires:
- manufacturing_bom
- manufacturing_routings
- manufacturing_work_centers
- inventory_basic

manufacturing_production_planning requires manufacturing_work_orders
manufacturing_mrp requires manufacturing_bom, inventory_basic, purchases
manufacturing_capacity_planning requires manufacturing_routings and manufacturing_work_centers

manufacturing_material_issues requires manufacturing_work_orders and inventory_basic
manufacturing_production_receipts requires manufacturing_work_orders and inventory_basic
manufacturing_scrap requires manufacturing_work_orders
manufacturing_rework requires manufacturing_work_orders

manufacturing_standard_costing requires manufacturing_bom and manufacturing_routings
manufacturing_actual_costing requires manufacturing_work_orders and core_accounting
manufacturing_variance_analysis requires manufacturing_standard_costing and manufacturing_actual_costing

manufacturing_quality requires manufacturing_work_orders
manufacturing_maintenance requires manufacturing_work_centers
manufacturing_traceability requires lot_serial_tracking and manufacturing_work_orders

manufacturing_batch_process requires manufacturing_core
manufacturing_yield requires manufacturing_batch_process
manufacturing_co_products requires manufacturing_batch_process

manufacturing_dashboards requires manufacturing_core
manufacturing_reports requires manufacturing_core
```

---

# 9. Manufacturing Navigation

When Manufacturing is enabled, show:

```text
Manufacturing
- Dashboard
- Items
- Bills of Materials
- Routings
- Work Centers
- Production Planning
- Material Requirements
- Work Orders
- Material Issues
- Production Receipts
- Scrap & Rework
- Quality
- Maintenance
- Product Costing
- Manufacturing Reports
```

Optional additional navigation:

```text
Inventory
- Items
- Warehouses
- Stock Movements
- Lots & Serial Numbers
- Transfers
- Counts
- Valuation
```

Core customers must not see Manufacturing or Inventory terminology unless those modules are enabled.

---

# 10. Manufacturing Dashboard

Show only for organizations with `manufacturing_dashboards`.

Recommended widgets:

- Open work orders
- Work orders due today
- Delayed work orders
- Planned production
- Actual production
- Material shortages
- Raw-material inventory
- Work-in-progress inventory
- Finished-goods inventory
- Scrap rate
- Rework rate
- Production efficiency
- Capacity utilization
- Machine downtime
- Standard cost
- Actual cost
- Cost variance
- Top production variances
- Quality failures
- Maintenance due
- On-time completion
- Inventory turnover

---

# 11. Manufacturing Core Data Structure

Recommended hierarchy:

```text
Entity
→ Plant
→ Warehouse
→ Work Center
→ Production Line
→ Machine
→ Product
→ Bill of Materials
→ Routing
→ Work Order
→ Production Run
```

Each production transaction should remain connected to:

- Entity
- Plant
- Warehouse
- Work center
- Cost center
- Product
- BOM
- Routing
- Work order
- Batch or lot
- Currency
- Journal entry

---

# 12. Manufacturing Item Types

Create:

```ts
export type ManufacturingItemType =
  | "raw-material"
  | "component"
  | "subassembly"
  | "finished-good"
  | "by-product"
  | "co-product"
  | "packaging"
  | "consumable"
  | "service"
  | "scrap"
```

Each item may have:

- Item code
- Description
- Unit of measure
- Inventory account
- WIP account
- Finished-goods account
- Cost-of-sales account
- Purchase account
- Sales account
- Standard cost
- Average cost
- Last purchase cost
- Lot tracking
- Serial tracking
- Shelf life
- Reorder level
- Lead time
- Preferred supplier
- Default warehouse
- Product category
- Tax code
- Cost center

---

# 13. Bill of Materials

Support:

- Multi-level BOM
- Effective dates
- Versioning
- Alternative BOM
- Component quantities
- Units of measure
- Expected scrap
- Yield
- Substitute materials
- By-products
- Co-products
- Packaging
- Labor and overhead references

Recommended model:

```ts
export type BillOfMaterials = {
  id: string
  entityId: string

  code: string
  name: string
  productItemId: string

  version: number
  status:
    | "draft"
    | "approved"
    | "inactive"
    | "archived"

  effectiveFrom: string
  effectiveTo?: string

  expectedOutputQuantity: number
  expectedYieldPercent?: number

  components: BomComponent[]

  createdAt: string
  updatedAt: string
}
```

Approved BOM versions must remain immutable.

---

# 14. Routing

A routing defines production operations.

Example:

```text
Operation 10 — Cutting
Operation 20 — Welding
Operation 30 — Painting
Operation 40 — Assembly
Operation 50 — Quality Inspection
```

Each operation may include:

- Work center
- Setup time
- Run time
- Queue time
- Labor skill
- Machine
- Standard labor rate
- Standard machine rate
- Quality checkpoint
- Outsourced flag

---

# 15. Work Centers

Create work centers for:

- Production lines
- Machine groups
- Labor groups
- Assembly areas
- Quality stations
- Packaging stations

Track:

- Available hours
- Capacity
- Efficiency
- Cost rate
- Labor rate
- Machine rate
- Overhead rate
- Maintenance status
- Cost center
- Plant
- Calendar

---

# 16. Work Orders

Work order workflow:

```text
Planned
→ Released
→ In Progress
→ Partially Completed
→ Completed
→ Closed
```

Optional states:

```text
On Hold
Cancelled
```

Each work order contains:

- Work-order number
- Product
- BOM version
- Routing version
- Planned quantity
- Completed quantity
- Scrap quantity
- Rework quantity
- Start date
- Due date
- Plant
- Warehouse
- Cost center
- Material requirements
- Operations
- Labor
- Machine time
- Standard cost
- Actual cost
- Variance

---

# 17. Production Planning

Support:

- Demand forecast
- Sales-order demand
- Reorder demand
- Safety-stock demand
- Planned production
- Work-order proposals
- Material availability
- Capacity availability
- Due-date planning

The first release may use manual demand plus sales-order demand.

Do not build advanced optimization before reliable master data exists.

---

# 18. Material Requirements Planning

MRP should calculate:

```text
Gross requirement
- Available inventory
- Scheduled receipts
+ Safety stock
= Net requirement
```

Output:

- Suggested purchase orders
- Suggested work orders
- Material shortage report
- Required dates
- Reschedule recommendations

MRP proposals are management records until approved.

Do not post MRP proposals to the General Ledger.

---

# 19. Material Issues

When raw materials are issued to production:

```text
Dr Work in progress
    Cr Raw-material inventory
```

The transaction must include:

- Work order
- Product
- Material item
- Quantity
- Warehouse
- Lot or serial
- Cost
- Cost center
- Journal reference

Material issue must not create expense immediately unless the configured manufacturing policy requires it.

---

# 20. Production Receipt

When finished goods are received:

```text
Dr Finished-goods inventory
    Cr Work in progress
```

Use actual or standard cost according to the entity policy.

Capture:

- Work order
- Product
- Quantity completed
- Warehouse
- Batch/lot
- Cost
- Completion date
- Journal reference

---

# 21. Work in Progress

WIP should contain:

- Material cost
- Direct labor
- Machine cost
- Production overhead
- Subcontract cost
- Other manufacturing cost

The system must distinguish:

```text
Raw material
Work in progress
Finished goods
Cost of goods sold
```

Do not charge production cost directly to COGS before finished goods are sold.

---

# 22. Product Costing

Support:

```ts
export type ManufacturingCostMethod =
  | "standard"
  | "weighted-average"
  | "fifo"
  | "actual"
```

Recommended first release:

- Standard costing
- Weighted-average inventory valuation

Advanced FIFO may be added later.

Product cost should include configured components:

```text
Materials
Direct labor
Machine cost
Production overhead
Subcontract cost
Expected scrap
```

---

# 23. Standard Cost

Standard cost may be built from:

```text
BOM material quantities × standard material rates
+ routing labor hours × standard labor rates
+ machine hours × machine rates
+ overhead absorption
```

Preserve cost versions and effective dates.

Do not rewrite historical production costs when standard cost changes.

---

# 24. Actual Cost

Actual work-order cost should derive from:

- Actual materials issued
- Actual labor recorded
- Actual machine time
- Actual overhead
- Actual subcontract cost
- Scrap and rework

Actual cost must reconcile to posted journal activity.

Do not store a separate authoritative cost that can drift from the ledger.

---

# 25. Manufacturing Variances

Support:

- Material price variance
- Material usage variance
- Labor rate variance
- Labor efficiency variance
- Machine rate variance
- Machine efficiency variance
- Overhead spending variance
- Overhead volume variance
- Yield variance
- Scrap variance
- Subcontract variance

Post variance according to configured accounts.

Example:

```text
Dr/Cr Manufacturing variance
    Cr/Dr WIP or inventory
```

Use centralized posting rules.

---

# 26. Scrap

Track:

- Work order
- Operation
- Item
- Quantity
- Reason
- Recoverable value
- Disposal cost
- Responsible work center
- Cost center

Possible accounting:

```text
Dr Scrap expense
    Cr Work in progress
```

or allocate normal scrap into product cost.

Use explicit policy:

```ts
export type ScrapAccountingPolicy =
  | "normal-to-product-cost"
  | "abnormal-to-expense"
  | "manual"
```

---

# 27. Rework

Track:

- Original work order
- Rework work order
- Reason
- Material
- Labor
- Machine time
- Cost
- Responsibility
- Quality event

Rework cost may be:

- Included in product cost
- Charged to variance
- Charged to warranty/quality expense

Use configured policy.

---

# 28. Quality Management

Support:

- Incoming inspection
- In-process inspection
- Final inspection
- Quality hold
- Rejection
- Release
- Non-conformance
- Corrective action
- Quality cost

Quality records should link to:

- Supplier
- Item
- Lot
- Work order
- Operation
- Customer complaint where applicable

Quality records do not create accounting entries unless they trigger scrap, rework, return, or write-off.

---

# 29. Maintenance

Support:

- Preventive maintenance
- Corrective maintenance
- Breakdown
- Maintenance work orders
- Spare parts
- Labor
- Downtime
- Machine availability
- Maintenance cost

Maintenance cost should post to:

- Maintenance expense
- Asset improvement
- Production overhead
- WIP where policy permits

Use explicit account mapping.

---

# 30. Lot and Serial Traceability

Traceability must support:

```text
Supplier lot
→ Raw-material receipt
→ Material issue
→ Work order
→ Production batch
→ Finished-good lot
→ Customer shipment
```

This is essential for:

- Food
- Pharmaceutical
- Chemical
- Regulated products
- Warranty tracking
- Product recalls

Historical traceability must remain immutable.

---

# 31. Subcontract Manufacturing

Optional add-on.

Workflow:

```text
Material sent to subcontractor
→ Subcontract service
→ Material returned
→ Finished or semi-finished receipt
→ Supplier bill
```

Accounting may include:

```text
Dr Subcontract WIP
    Cr Inventory

Dr WIP / Finished goods
    Cr Subcontract WIP
    Cr Trade payables
```

Use configured policy.

---

# 32. Process Manufacturing Add-On

For batch/process industries support:

- Formulas
- Batches
- Yield
- Potency
- Co-products
- By-products
- Variable output
- Loss
- Expiry
- Quality release
- Batch genealogy

This add-on should not appear for discrete manufacturers unless enabled.

---

# 33. Cost Centers in Manufacturing

Cost centers may represent:

- Production department
- Production line
- Plant
- Quality control
- Maintenance
- Warehouse
- Utilities
- Shared services

Manufacturing transactions should support both:

```text
Account
Cost center
Work center
Work order
Product
```

Do not merge cost center and work center.

---

# 34. Project Accounting as Add-On

Manufacturing companies may optionally use Projects for:

- New product development
- Plant expansion
- Customer-specific contracts
- Tooling
- Installation projects
- Capital projects

Project fields appear only when the Projects module is enabled.

---

# 35. Manufacturing Accounting Integration

All manufacturing accounting must post through the existing General Journal service.

Do not update General Ledger balances directly.

Typical postings:

## Raw material purchase

```text
Dr Raw-material inventory
Dr Input tax
    Cr Trade payables
```

## Material issue

```text
Dr Work in progress
    Cr Raw-material inventory
```

## Labor absorption

```text
Dr Work in progress
    Cr Labor absorption / Payroll clearing
```

## Overhead absorption

```text
Dr Work in progress
    Cr Manufacturing overhead absorbed
```

## Finished-goods receipt

```text
Dr Finished-goods inventory
    Cr Work in progress
```

## Sale

```text
Dr Trade receivables
    Cr Revenue

Dr Cost of goods sold
    Cr Finished-goods inventory
```

## Abnormal scrap

```text
Dr Scrap expense
    Cr Work in progress
```

---

# 36. Manufacturing Reports

Add:

1. Production Summary
2. Work Order Status
3. Material Requirements
4. Material Shortages
5. Production Plan vs Actual
6. Capacity Utilization
7. Work Center Efficiency
8. Machine Downtime
9. Raw-Material Inventory
10. WIP Inventory
11. Finished-Goods Inventory
12. Inventory Valuation
13. Product Cost
14. Work Order Cost
15. Standard vs Actual Cost
16. Manufacturing Variances
17. Scrap Report
18. Rework Report
19. Yield Report
20. Quality Report
21. Maintenance Cost
22. Lot Traceability
23. Inventory Turnover
24. Product Profitability
25. Plant Income Statement
26. Cost Center by Plant
27. Manufacturing Cash Requirements

Every accounting amount must drill down to source documents or journal lines.

---

# 37. Manufacturing Edition Dashboard Visibility

Core customers:

```text
No Manufacturing navigation
No inventory-production fields
No manufacturing dashboard
```

Manufacturing customers:

```text
Manufacturing navigation visible
Inventory and production fields visible
Manufacturing dashboard visible
```

Projects and Construction modules remain hidden unless separately included.

---

# 38. Form Filtering

Examples:

## Bill line

Core:

```text
Account
Tax
Amount
```

Manufacturing:

```text
Item
Warehouse
Lot
Cost center
Purchase account
Tax
Quantity
Unit cost
```

## Journal line

Manufacturing may add:

```text
Item
Warehouse
Work order
Work center
Production batch
```

Only show manufacturing fields when the relevant modules are enabled.

---

# 39. Manufacturing Seed Data

Add:

```ts
seedManufacturingOrganization(...)
```

Suggested seed:

- One plant
- Raw-material warehouse
- WIP warehouse
- Finished-goods warehouse
- Three raw materials
- One finished product
- One BOM
- One routing
- Three work centers
- One planned work order
- One completed work order
- One material issue
- One production receipt
- One scrap transaction
- Standard and actual cost example

Do not seed manufacturing data into other editions.

---

# 40. Manufacturing Onboarding

For Manufacturing edition ask:

- Manufacturing type
- Number of plants
- Number of warehouses
- Costing method
- Lot/serial requirements
- Standard or actual costing
- Discrete or process production
- Quality requirements
- Maintenance requirements
- Projects add-on needed?
- Multi-currency needed?
- Advanced tax needed?

Do not require advanced answers before basic setup can be completed.

---

# 41. Commercial Packaging

To avoid a prohibitive price, structure Manufacturing as:

## Ledgora Manufacturing Essentials

- Core accounting
- Inventory
- Warehouses
- Items
- BOM
- Routings
- Work centers
- Work orders
- Material issues
- Production receipts
- Standard product costing
- Basic manufacturing reports

## Manufacturing Control Add-On

- MRP
- Production planning
- Capacity planning
- Variance analysis
- Scrap and rework
- Advanced costing
- Advanced dashboards

## Quality & Traceability Add-On

- Lots and serials
- Inspections
- Non-conformance
- Corrective actions
- Batch genealogy
- Recall traceability

## Maintenance Add-On

- Preventive maintenance
- Breakdown maintenance
- Spare parts
- Downtime
- Maintenance costing

## Process Manufacturing Add-On

- Formulas
- Batches
- Yield
- Co-products
- By-products
- Expiry
- Potency

## Projects Add-On

- Project accounting
- Capital projects
- R&D projects
- Customer-specific manufacturing projects

This structure lets a small plant buy only Essentials.

---

# 42. Edition Comparison

| Edition | Intended customer | Main capabilities |
|---|---|---|
| Ledgora Core | General SMEs | Bookkeeping, sales, purchases, statements |
| Ledgora Projects | Project-based SMEs | Projects, budgets, profitability, project cash flow |
| Ledgora Construction | Contractors and engineering companies | BOQ, retention, progress claims, subcontracts, WIP |
| Ledgora Manufacturing | Manufacturing plants | Inventory, BOM, work orders, costing, production control |
| Ledgora Enterprise | Larger or multi-entity groups | All modules, advanced controls, customization |

---

# 43. Acceptance Scenarios

## Manufacturing Essentials

Expected visible:

- Accounting
- Sales
- Purchases
- Inventory
- Manufacturing
- Basic costing
- Manufacturing reports

Expected hidden unless purchased:

- Projects
- Construction
- Advanced quality
- Maintenance
- Process manufacturing

## Manufacturing Plus Projects

Expected:

- Manufacturing modules
- Projects
- Project and cost-center fields
- R&D/capital project reporting

## Manufacturing Downgrade

If Manufacturing is disabled:

- Manufacturing navigation hidden
- New work orders blocked
- Historical inventory and journal records preserved
- GL unchanged
- Existing production documents remain readable according to policy
- No data deleted

---

# 44. Tests

Add entitlement tests for:

1. Manufacturing edition preset
2. Manufacturing includes Core
3. Manufacturing does not automatically include Projects
4. Manufacturing Essentials module visibility
5. Manufacturing Control add-on
6. Quality add-on
7. Maintenance add-on
8. Process Manufacturing add-on
9. Projects add-on
10. Manufacturing dependencies expand correctly
11. Manufacturing navigation filtering
12. Manufacturing route guards
13. Manufacturing form fields
14. Core hides manufacturing fields
15. Manufacturing seed isolation
16. Manufacturing downgrade preserves data
17. Suspended subscription blocks production posting
18. Enterprise includes manufacturing
19. Stable selectors
20. LocalStorage migration
21. Protected route refresh

---

# 45. QA

Run:

- TypeScript typecheck
- Full test suite
- Production build
- Core edition smoke test
- Projects edition smoke test
- Construction edition smoke test
- Manufacturing edition smoke test
- Enterprise edition smoke test
- Manufacturing add-on smoke tests
- Navigation filtering
- Route guards
- Form filtering
- Seed isolation
- Downgrade preservation
- Subscription posting guard
- LocalStorage migration
- Selector-safety scan
- Clean dev-server restart

---

# 46. Manufacturing Implementation Phases

Do not build all manufacturing functions in the entitlement-foundation change.

## Manufacturing Phase 1 — Essentials

- Manufacturing project/profile settings
- Plants
- Warehouses
- Items
- Units of measure
- BOM
- Routings
- Work centers
- Work orders
- Material issues
- Production receipts
- Standard costing
- Basic reports

## Manufacturing Phase 2 — Planning and Control

- Demand planning
- MRP
- Production planning
- Capacity planning
- Scrap
- Rework
- Actual costing
- Variance analysis
- Advanced dashboard

## Manufacturing Phase 3 — Quality and Maintenance

- Inspections
- Quality holds
- Non-conformance
- Corrective action
- Preventive maintenance
- Breakdown maintenance
- Spare-parts usage
- Downtime reporting

## Manufacturing Phase 4 — Process and Traceability

- Batch processing
- Formulas
- Yield
- Co-products
- By-products
- Expiry
- Potency
- Full lot genealogy
- Recall traceability

---

# Final Principle

Ledgora should remain:

```text
One platform
One accounting engine
Multiple commercial editions
Optional industry modules
Preserved historical data
```

A Manufacturing customer should experience an application built for production plants.

A Core customer should never be forced to see or pay for manufacturing functionality.

A Construction customer should not see manufacturing terminology unless that module is separately enabled.

Manufacturing and Projects may be combined only when the customer needs both.
