# Ledgora Inventory Module — Phase 1 Implementation Specification

## Objective

Build Inventory as a shared Ledgora module that can serve Manufacturing, Construction, trading, retail, wholesale, and project-based businesses.

Inventory must not be hardwired only inside Manufacturing.

Use the existing:

- React + TypeScript application
- Zustand + LocalStorage
- Chart of Accounts
- General Journal and General Ledger
- Invoices, credit notes, bills, supplier credits
- Tax and currency engines
- Cost centers and projects
- Entitlement framework
- Navigation, routing, dashboard, and reporting patterns

Do not create a separate inventory application.

---

## 1. Entitlements

Support:

```ts
type LedgoraModule =
  | ...
  | "inventory_basic"
  | "inventory_advanced"
  | "warehouses"
  | "lot_serial_tracking"
  | "landed_cost"
```

Dependencies:

```text
warehouses requires inventory_basic
inventory_advanced requires inventory_basic
lot_serial_tracking requires inventory_basic
landed_cost requires inventory_basic and purchases
manufacturing_core requires inventory_basic
construction_materials requires inventory_basic
```

Inventory must be purchasable independently of Manufacturing.

---

## 2. Core Accounting Principle

Inventory quantity and value must come from posted stock movements.

```text
Quantity on hand
=
Posted inbound movements
-
Posted outbound movements
```

All inventory accounting must post through the existing General Journal engine.

Never update General Ledger balances directly.

Posted inventory movements are immutable. Corrections use reversal and reposting.

---

## 3. Inventory Navigation

When `inventory_basic` is enabled:

```text
Inventory
- Dashboard
- Items
- Item Categories
- Units of Measure
- Warehouses
- Stock Movements
- Goods Receipts
- Goods Issues
- Transfers
- Adjustments
- Stock Counts
- Reports
```

Hide Inventory completely when entitlement is absent.

Do not expose unfinished routes.

---

## 4. Item Master

Create:

```ts
export type InventoryItemType =
  | "inventory"
  | "non-inventory"
  | "service"
  | "raw-material"
  | "component"
  | "subassembly"
  | "finished-good"
  | "packaging"
  | "consumable"
  | "spare-part"
  | "scrap"
```

```ts
export type InventoryItem = {
  id: string
  entityId: string

  code: string
  name: string
  description?: string

  itemType: InventoryItemType
  categoryId?: string

  baseUnitId: string
  purchaseUnitId?: string
  salesUnitId?: string

  isInventoryTracked: boolean
  isPurchasable: boolean
  isSellable: boolean
  isManufacturable: boolean

  trackingMode: "none" | "lot" | "serial"

  valuationMethod:
    | "weighted-average"
    | "standard"
    | "fifo"

  inventoryAccountId?: string
  inventoryAdjustmentAccountId?: string
  costOfGoodsSoldAccountId?: string
  salesAccountId?: string
  purchaseAccountId?: string
  purchaseReturnAccountId?: string
  salesReturnAccountId?: string
  inventoryWriteOffAccountId?: string
  inventoryGainAccountId?: string

  defaultTaxCodeId?: string
  defaultSupplierId?: string
  defaultWarehouseId?: string
  defaultCostCenterId?: string

  standardCost?: number
  reorderLevel?: number
  reorderQuantity?: number
  safetyStock?: number
  leadTimeDays?: number

  allowNegativeStock?: boolean

  status: "active" | "inactive" | "archived"

  createdAt: string
  updatedAt: string
}
```

Rules:

- Item code unique within entity.
- Archived items cannot be used in new documents.
- Historical records preserve item snapshots.
- Service/non-inventory items create no stock movements.
- Changing account mappings never rewrites history.
- Manufacturing-only fields remain hidden unless Manufacturing is enabled.

---

## 5. Item Categories

Create hierarchical categories:

```ts
export type ItemCategory = {
  id: string
  entityId: string

  code: string
  name: string
  parentId?: string
  description?: string

  defaultInventoryAccountId?: string
  defaultCogsAccountId?: string
  defaultSalesAccountId?: string
  defaultPurchaseAccountId?: string

  status: "active" | "inactive"
}
```

Category defaults populate new items only.

Do not silently update existing item mappings when category defaults change.

---

## 6. Units of Measure

Create:

```ts
export type UnitOfMeasure = {
  id: string
  entityId: string

  code: string
  name: string
  symbol: string

  category:
    | "quantity"
    | "weight"
    | "volume"
    | "length"
    | "area"
    | "time"
    | "custom"

  decimalPlaces: number
  status: "active" | "inactive"
}
```

Examples:

```text
EA, BOX, KG, G, L, M, M2, M3, HOUR
```

Phase 1 may support one base unit per item.

Multiple-unit conversions may be deferred.

---

## 7. Warehouses

Create:

```ts
export type Warehouse = {
  id: string
  entityId: string

  code: string
  name: string
  description?: string

  type:
    | "main"
    | "raw-material"
    | "wip"
    | "finished-goods"
    | "returns"
    | "quarantine"
    | "scrap"
    | "site"
    | "transit"
    | "virtual"

  location?: string
  costCenterId?: string
  projectId?: string

  allowNegativeStock?: boolean

  status: "active" | "inactive" | "archived"

  createdAt: string
  updatedAt: string
}
```

Rules:

- Warehouse code unique by entity.
- A warehouse with stock cannot be deleted.
- Archived warehouses remain historically visible.
- Project/cost-center links are optional defaults.
- Construction site and Manufacturing WIP warehouses use the same warehouse engine.

---

## 8. Stock Movement Ledger

Create:

```ts
export type StockMovementType =
  | "opening-balance"
  | "purchase-receipt"
  | "purchase-return"
  | "sales-delivery"
  | "sales-return"
  | "warehouse-transfer-out"
  | "warehouse-transfer-in"
  | "stock-adjustment-in"
  | "stock-adjustment-out"
  | "stock-count-in"
  | "stock-count-out"
  | "manufacturing-material-issue"
  | "manufacturing-production-receipt"
  | "manufacturing-scrap"
  | "project-material-issue"
  | "project-material-return"
  | "landed-cost-adjustment"
```

```ts
export type StockMovement = {
  id: string
  entityId: string

  movementNumber: string
  movementType: StockMovementType

  movementDate: string
  postingDate: string

  itemId: string
  warehouseId: string
  locationId?: string

  direction: "in" | "out"

  quantity: number
  baseUnitId: string

  unitCostBase: number
  totalCostBase: number

  documentCurrency?: string
  documentUnitCost?: number
  exchangeRate?: number

  lotId?: string
  serialNumbers?: string[]

  projectId?: string
  costCenterId?: string

  sourceDocumentType:
    | "opening-balance"
    | "goods-receipt"
    | "goods-issue"
    | "transfer"
    | "adjustment"
    | "stock-count"
    | "bill"
    | "supplier-credit"
    | "invoice"
    | "credit-note"
    | "manufacturing"
    | "project"

  sourceDocumentId: string
  sourceLineId?: string

  journalEntryId?: string
  journalLineIds?: string[]

  itemSnapshot: {
    code: string
    name: string
    itemType: InventoryItemType
    baseUnitCode: string
  }

  warehouseSnapshot: {
    code: string
    name: string
  }

  accountSnapshot: {
    inventoryAccountId?: string
    cogsAccountId?: string
    adjustmentAccountId?: string
  }

  status: "posted" | "reversed"

  reversalOfMovementId?: string
  reversedByMovementId?: string

  createdAt: string
  createdBy?: string
}
```

Posted movements must never be edited.

---

## 9. Numbering

Recommended:

```text
GRN-YYYY-####
GIN-YYYY-####
TRF-YYYY-####
ADJ-YYYY-####
CNT-YYYY-####
MOV-YYYY-####
```

Sequences must be entity-specific.

---

## 10. Inventory Settings

Create:

```ts
export type InventorySettings = {
  entityId: string

  enabled: boolean

  defaultValuationMethod:
    | "weighted-average"
    | "standard"

  negativeStockPolicy:
    | "block"
    | "warn"
    | "allow"

  salesRecognitionMode:
    | "on-invoice"
    | "on-delivery"

  purchaseRecognitionMode:
    | "on-bill"
    | "on-goods-receipt"

  useGrni: boolean

  defaultWarehouseId?: string

  inventoryGainAccountId?: string
  inventoryLossAccountId?: string
  goodsReceivedNotInvoicedAccountId?: string
  purchasePriceVarianceAccountId?: string
  stockInTransitAccountId?: string
}
```

Recommended default negative-stock policy:

```text
block
```

---

## 11. Opening Balances

Opening inventory requires:

- Item
- Warehouse
- Quantity
- Unit cost
- Total value
- Opening date
- Lot/serial when enabled

Accounting:

```text
Dr Inventory
    Cr Opening Balance Equity / Migration Clearing
```

Opening balances must create both:

- Stock movements
- Journal entries

Never seed quantity without value.

---

## 12. Goods Receipts

Create Goods Receipt Note workflow:

```text
Draft
→ Posted
→ Reversed
```

Fields:

- Receipt number
- Supplier
- Receipt date
- Warehouse
- Supplier delivery reference
- Currency
- Exchange rate
- Lines
- Attachments
- Notes

Line fields:

- Item
- Quantity
- Unit
- Unit cost
- Warehouse
- Lot/serial
- Project
- Cost center
- Description

Preferred accounting when GRNI is enabled:

```text
Dr Inventory
    Cr Goods Received Not Invoiced
```

Later supplier bill:

```text
Dr Goods Received Not Invoiced
Dr Input Tax
    Cr Trade Payables
```

Simplified Phase 1 may also support direct receipt on bill.

---

## 13. Direct Inventory Receipt on Supplier Bill

Add to bill lines:

```ts
itemId?: string
warehouseId?: string
quantity?: number
unitId?: string

inventoryReceiptMode?:
  | "none"
  | "receive-on-bill"
  | "received-separately"
```

When receiving on bill:

```text
Dr Inventory
Dr Recoverable Input Tax
    Cr Trade Payables
```

Requirements:

- Stock movement and journal entry succeed or fail together.
- Reversal reverses both.
- Inventory valuation excludes recoverable tax.
- Foreign-currency inventory value uses the posting-date exchange rate.

---

## 14. Goods Issues

Create Goods Issue workflow.

Uses:

- Internal consumption
- Project issue
- Construction site use
- Samples
- Damage
- Maintenance spare parts
- Future Manufacturing material issue

Fields:

- Issue number
- Date
- Warehouse
- Reason
- Project
- Cost center
- Lines
- Notes

Typical accounting:

```text
Dr Expense / Project Cost / WIP
    Cr Inventory
```

Outbound cost must come from the valuation engine.

---

## 15. Invoice Integration

Add to invoice lines:

```ts
itemId?: string
warehouseId?: string
quantity?: number
unitId?: string

inventoryFulfillmentMode?:
  | "none"
  | "issue-on-invoice"
  | "delivered-separately"
```

For issue-on-invoice:

```text
Dr Trade Receivables
    Cr Revenue
    Cr Output Tax

Dr Cost of Goods Sold
    Cr Inventory
```

Rules:

- Service items create no stock movement.
- Inventory item requires warehouse.
- Insufficient stock blocks issue unless policy permits otherwise.
- COGS must post once only.
- Preserve assigned inventory cost on the issued invoice line.

---

## 16. Customer Returns and Credit Notes

Add:

```ts
returnToInventory: boolean
returnWarehouseId?: string
```

Physical return:

```text
Dr Inventory
    Cr Cost of Goods Sold
```

Credit note separately reverses revenue, tax, and receivable.

Rules:

- Financial-only credit creates no stock movement.
- Use original issue cost when available.
- Prevent returns above original delivered quantity less earlier returns.
- Link return movement to original invoice/delivery line.

---

## 17. Supplier Returns and Supplier Credits

Add:

```ts
returnInventory: boolean
returnWarehouseId?: string
```

Physical return creates outbound stock movement.

Rules:

- Financial-only supplier credit creates no stock movement.
- Use original receipt cost.
- Prevent return quantity above quantity received less previous returns.

---

## 18. Warehouse Transfers

Create two linked movements:

```text
Source warehouse: Transfer Out
Destination warehouse: Transfer In
```

Requirements:

- Source and destination differ.
- Quantity and value remain equal.
- Total company quantity and value remain unchanged.
- No P&L impact.
- No GL entry when both warehouses share the same inventory account.
- If inventory accounts differ:

Dr Destination Inventory
    Cr Source Inventory
```

---

## 19. Stock Adjustments

Reasons:

```ts
type StockAdjustmentReason =
  | "damage"
  | "loss"
  | "found"
  | "expiry"
  | "write-off"
  | "data-correction"
  | "quality-rejection"
  | "other"
```

Increase:

```text
Dr Inventory
    Cr Inventory Gain
```

Decrease:

```text
Dr Inventory Loss / Write-Off
    Cr Inventory
```

Require reason and notes.

---

## 20. Stock Counts

Workflow:

```text
Draft
→ Counting
→ Reviewed
→ Posted
→ Reversed
```

Capture:

- Count number
- Warehouse
- Freeze date/time
- System quantity
- Counted quantity
- Variance
- Value
- Reviewer
- Reason

When count begins, freeze the system quantity snapshot.

Positive variance:

```text
Dr Inventory
    Cr Inventory Gain
```

Negative variance:

```text
Dr Inventory Loss
    Cr Inventory
```

---

## 21. Valuation Engine

Create:

```text
src/lib/inventoryValuation.ts
```

Required Phase 1 method:

```text
Weighted-average cost
```

Optional:

```text
Standard cost
```

FIFO may be deferred.

---

## 22. Weighted-Average Cost

After receipt:

```text
New average cost =
(Existing quantity × Existing average cost
 + Incoming quantity × Incoming unit cost)
÷
New quantity
```

Outbound movement uses average cost at posting time.

Rules:

- Preserve cost on every posted movement.
- Later receipts do not rewrite previous issue costs.
- Reversal uses original movement cost.
- Negative inventory blocked by default.

---

## 23. Standard Cost

When enabled:

```text
Dr Inventory at Standard Cost
Dr/Cr Purchase Price Variance
Dr Input Tax
    Cr Trade Payables
```

Do not allow changing valuation method after movements exist unless quantity is zero and a controlled migration is performed.

---

## 24. Inventory Balance Service

Create:

```ts
getInventoryBalance(...)
getItemWarehouseBalance(...)
getQuantityOnHand(...)
getInventoryValue(...)
getAvailableQuantity(...)
getInventoryAsOf(...)
```

```ts
export type InventoryBalance = {
  entityId: string
  itemId: string
  warehouseId?: string

  quantityOnHand: number
  reservedQuantity: number
  availableQuantity: number

  averageUnitCost: number
  inventoryValue: number

  asOfDate: string
}
```

For Phase 1:

```text
reservedQuantity = 0
availableQuantity = quantityOnHand
```

Balances must be derived, not manually stored as authoritative values.

---

## 25. Historical As-of Reports

Reports must support an as-of date by calculating movements posted up to that date.

Do not use only current totals.

---

## 26. Negative Stock

Entity policy:

```ts
type NegativeStockPolicy =
  | "block"
  | "warn"
  | "allow"
```

Recommended production default:

```text
block
```

Phase 1 should fully support `block`.

`warn` and `allow` may be deferred unless properly tested.

---

## 27. Currency Integration

Inventory valuation is kept in entity base currency.

Preserve:

- Document currency
- Document unit cost
- Exchange rate
- Base-currency unit cost
- Base-currency total

Later payment FX differences affect payables, not inventory.

Ordinary inventory is not revalued for exchange-rate changes.

---

## 28. Tax Integration

Recoverable tax is excluded from inventory value.

Example:

```text
Dr Inventory                  1,000
Dr Recoverable Input VAT        150
    Cr Trade Payables         1,150
```

Nonrecoverable tax may be capitalized according to the tax engine.

---

## 29. Cost Center Integration

Examples:

- Internal consumption
- Maintenance spare parts
- Marketing samples
- Inventory losses
- Production expense

Recommended behavior:

- Inventory asset line normally untagged.
- Expense/WIP line carries cost center.
- Transfer has no P&L cost center.
- Adjustment gain/loss may carry responsible cost center.

Use existing snapshots and requirement validation.

---

## 30. Project Integration

When Projects is enabled:

- Stock issues may be charged to projects.
- Site warehouse may default to project.
- Project reports include issued material cost.
- Project and warehouse remain separate dimensions.

Typical entry:

```text
Dr Project Material Cost
    Cr Inventory
```

---

## 31. Construction Extension Points

Preserve optional future fields:

```ts
wbsId?: string
costCodeId?: string
siteRequisitionId?: string
siteReceiptId?: string
```

Future Construction flow:

```text
Main Warehouse
→ Site Warehouse
→ WBS / Cost Code Issue
→ Return or Waste
```

Do not implement full construction-material control in Inventory Phase 1.

---

## 32. Manufacturing Extension Points

Preserve optional fields:

```ts
manufacturingWorkOrderId?: string
manufacturingOperationId?: string
manufacturingBatchId?: string
```

Future Manufacturing flow:

```text
Raw Material Receipt
→ Material Issue
→ WIP
→ Finished Goods Receipt
→ Scrap / Rework
```

Do not implement BOM or work-order posting in this phase.

---

## 33. Posting Atomicity

Create centralized posting orchestration:

```ts
postInventoryDocument(...)
```

These must succeed or fail together:

- Source document status
- Stock movements
- Valuation result
- Journal entry
- Source-document links
- Audit record

For Zustand/LocalStorage:

1. Validate everything first.
2. Build stock movement plan.
3. Build journal entry plan.
4. Commit only after both plans are valid.
5. Prevent partial state.
6. Add integration tests for failure rollback.

---

## 34. Reversal

Reversal must:

- Create opposite stock movement.
- Reverse original journal.
- Preserve original cost.
- Link original and reversal.
- Restore item availability.
- Restore returnable quantities.
- Preserve audit history.

Do not recalculate reversal using current average cost.

Block reversal if later consumption would make the reversal invalid; require a controlled return/correction workflow instead.

---

## 35. Inventory Dashboard

Show:

- Total inventory value
- Raw-material value
- Finished-goods value
- Active inventory items
- Low-stock items
- Out-of-stock items
- Recent receipts
- Recent issues
- Adjustments
- Negative-stock exceptions
- Top-value items

Show WIP, lot expiry, and manufacturing widgets only when their modules are enabled.

---

## 36. Required Reports

1. Inventory Summary
2. Inventory Valuation
3. Stock Movement Ledger
4. Quantity by Item
5. Quantity by Warehouse
6. Inventory by Category
7. Low Stock
8. Out of Stock
9. Goods Receipt Register
10. Goods Issue Register
11. Transfer Register
12. Adjustment Register
13. Stock Count Variance
14. Inventory Account Reconciliation
15. Inventory as of Date
16. Item Transaction History

Every amount must drill down to movement and journal entry.

---

## 37. Inventory-to-GL Reconciliation

Create:

```text
Inventory subledger value
versus
Inventory General Ledger balance
```

Filters:

- Entity
- Inventory account
- Warehouse
- Item
- As-of date

Show differences clearly.

This report is mandatory.

---

## 38. Stock Movement Ledger Columns

- Date
- Movement number
- Source document
- Type
- Item
- Warehouse
- In quantity
- Out quantity
- Running quantity
- Unit cost
- In value
- Out value
- Running value
- Project
- Cost center
- Journal reference

Support CSV export.

---

## 39. Inventory Store

Recommended:

```text
src/store/inventoryStore.ts
```

State:

- Items
- Categories
- Units
- Warehouses
- Movements
- Goods receipts
- Goods issues
- Transfers
- Adjustments
- Stock counts
- Settings

Do not store derived balances as editable source data.

---

## 40. Validation

Create:

```ts
validateInventoryItem(...)
validateWarehouse(...)
validateGoodsReceipt(...)
validateGoodsIssue(...)
validateTransfer(...)
validateAdjustment(...)
validateStockCount(...)
validateAvailableStock(...)
validateInventoryAccountMappings(...)
```

Checks:

- Inventory item has inventory account.
- Sellable item has COGS account.
- Quantity positive.
- Stock available.
- Warehouses differ on transfer.
- Archived item not usable.
- Inactive warehouse not usable.
- Posting date not in locked period.
- Physical returns do not exceed original quantity.
- Service item creates no stock movement.

---

## 41. Audit Trail

Record:

- Item created/updated/archived
- Warehouse created/updated/archived
- Opening balance
- Receipt posted/reversed
- Issue posted/reversed
- Transfer posted/reversed
- Adjustment posted/reversed
- Stock count started/reviewed/posted/reversed
- Negative-stock override
- Inventory setting change
- Valuation method change attempt

---

## 42. Recommended Files

```text
src/
  types/
    inventory.ts
    inventoryDocuments.ts
    inventoryValuation.ts

  store/
    inventoryStore.ts

  lib/
    inventoryBalance.ts
    inventoryValuation.ts
    inventoryPosting.ts
    inventoryValidation.ts
    inventoryReversal.ts
    inventoryNumbering.ts
    inventoryReconciliation.ts
    inventoryMigration.ts
    inventorySeed.ts

  components/
    inventory/
      ItemPicker.tsx
      WarehousePicker.tsx
      ItemEditor.tsx
      WarehouseEditor.tsx
      GoodsReceiptEditor.tsx
      GoodsIssueEditor.tsx
      TransferEditor.tsx
      AdjustmentEditor.tsx
      StockCountEditor.tsx
      StockMovementTable.tsx

  pages/
    InventoryDashboardPage.tsx
    ItemsPage.tsx
    ItemCategoriesPage.tsx
    UnitsOfMeasurePage.tsx
    WarehousesPage.tsx
    GoodsReceiptsPage.tsx
    GoodsIssuesPage.tsx
    TransfersPage.tsx
    AdjustmentsPage.tsx
    StockCountsPage.tsx
    StockMovementsPage.tsx
    InventoryReportsPage.tsx
```

Modify:

- Module registry
- Edition presets
- Navigation
- Routes
- Dashboard registry
- Invoice types/editor/posting
- Credit note types/editor/posting
- Bill types/editor/posting
- Supplier credit types/editor/posting
- Global search
- Seed initialization
- Financial reporting/reconciliation

---

## 43. Phase 1 Scope

Implement now:

1. Entitlement wiring
2. Inventory settings
3. Item categories
4. Units
5. Item master
6. Warehouses
7. Stock movement ledger
8. Opening balances
9. Goods receipts
10. Goods issues
11. Transfers
12. Adjustments
13. Stock counts
14. Weighted-average valuation
15. Negative-stock blocking
16. Bill direct receipt
17. Invoice direct issue
18. Customer physical return
19. Supplier physical return
20. General Journal posting
21. Reversal
22. Dashboard
23. Core reports
24. Inventory-to-GL reconciliation
25. Seed data
26. Tests

---

## 44. Deferred to Phase 2

- Reservations
- Available-to-promise
- Purchase orders
- Sales orders
- Separate delivery notes
- Advanced GRNI matching
- Multiple-unit conversion
- FIFO
- Landed cost
- Inventory aging
- Slow-moving/dead stock
- Approval workflows
- Partial in-transit transfers
- Barcode scanning
- Mobile warehouse UI

---

## 45. Deferred to Lot/Serial Phase

- Lots
- Serials
- Expiry
- Quarantine
- Traceability
- Recall reporting

Prepare extension points only; do not expose incomplete workflows.

---

## 46. Deferred to Manufacturing

- BOM
- Routings
- Work centers
- Work orders
- MRP
- Material issue to production
- Production receipt
- WIP
- Manufacturing scrap/rework
- Manufacturing standard cost
- Manufacturing variances

---

## 47. Acceptance Scenario — Weighted Average

Start:

```text
Quantity 0
Value 0
```

Receipt 100 units at 10:

```text
Quantity 100
Average 10
Value 1,000
```

Receipt 50 units at 14:

```text
Average =
(100×10 + 50×14) ÷ 150
= 11.333333
```

Issue 60 units:

```text
Issue value = 680
Remaining quantity = 90
Remaining value = 1,020
Average remains 11.333333
```

Expected journal:

```text
Dr Cost of Goods Sold 680
    Cr Inventory 680
```

---

## 48. Acceptance Scenario — Customer Return

Return 10 units from the previous sale.

Expected:

- Inbound movement
- Use original sale issue cost
- Reverse COGS
- Credit note handles revenue/tax separately
- Return cannot exceed original delivered quantity less earlier returns

---

## 49. Acceptance Scenario — Transfer

Transfer 20 units from MAIN to SITE-A.

Expected:

- MAIN decreases by 20
- SITE-A increases by 20
- Same cost on both sides
- Total entity quantity/value unchanged
- No P&L effect

---

## 50. Acceptance Scenario — Stock Count

System quantity:

```text
90
```

Counted:

```text
87
```

Expected:

- Outbound variance movement for 3
- Debit inventory loss
- Credit inventory
- Frozen count snapshot retained

---

## 51. Acceptance Scenario — Reversal

Reverse a posted receipt.

Expected:

- Opposite movement uses original cost
- Journal reversal uses original values
- Original linked to reversal
- Stock and GL both restored
- Invalid reversal blocked if stock was already consumed

---

## 52. Acceptance Scenario — No Inventory Entitlement

Organization without Inventory:

- No Inventory navigation
- No item/warehouse fields
- Existing service invoices and bills still work
- Inventory validation does not run
- Protected routes blocked

---

## 53. Tests

Add tests for:

### Entitlements

1. Inventory hidden without entitlement
2. Inventory visible with entitlement
3. Warehouses dependency
4. Manufacturing depends on Inventory
5. Construction Materials depends on Inventory
6. Route guard
7. Navigation filtering
8. Global-search filtering

### Master Data

9. Unique item code
10. Unique warehouse code
11. Archived item blocked
12. Warehouse with stock cannot be deleted
13. Service item creates no movement
14. Inventory item requires account mappings

### Valuation

15. First receipt
16. Second receipt weighted average
17. Issue at current average
18. Historical issue cost preserved
19. Reversal at original cost
20. As-of balance
21. Zero quantity
22. Negative stock blocked
23. Valuation-method change blocked

### Documents

24. Opening balance
25. Goods receipt
26. Goods issue
27. Transfer
28. Adjustment increase
29. Adjustment decrease
30. Positive count variance
31. Negative count variance
32. Reversal
33. Atomic posting failure

### Sales and Purchases

34. Bill direct receipt
35. Invoice direct issue
36. Customer physical return
37. Financial-only customer credit
38. Supplier physical return
39. Financial-only supplier credit
40. Over-return blocked
41. Insufficient stock blocks invoice
42. COGS posts once

### Dimensions and Accounting

43. Cost-center issue
44. Project issue
45. Disabled dimensions skip validation
46. Currency snapshot
47. Recoverable tax excluded from value
48. Inventory subledger equals GL
49. Reconciliation difference exposed

### Persistence and UI

50. Movement running quantity
51. Movement running value
52. CSV export
53. LocalStorage hydration
54. Store migration
55. Stable selectors
56. Seed isolation
57. Protected-route refresh
58. Dashboard filtering
59. Form-field gating
60. Existing subscription migration

---

## 54. QA

Run:

- `tsc --noEmit`
- Full test suite
- Production build
- Inventory entitlement smoke test
- Core-without-inventory smoke test
- Manufacturing-with-inventory smoke test
- Item and warehouse tests
- Goods receipt and issue tests
- Transfer test
- Adjustment test
- Stock-count test
- Bill receipt test
- Invoice issue test
- Customer and supplier return tests
- Weighted-average valuation test
- Negative-stock test
- Reversal test
- Inventory-to-GL reconciliation test
- Route/navigation/search tests
- LocalStorage migration test
- Selector-safety scan
- Clean dev-server restart

Report:

- Files created
- Files modified
- Store and type design
- Valuation behavior
- Posting behavior
- Document integrations
- Reversal behavior
- Reports and reconciliation
- Entitlement behavior
- Tests
- Typecheck
- Build
- Deferred work

---

## Final Principle

```text
Stock quantity comes from posted movements.
Stock value comes from the valuation engine.
Accounting value comes from journal entries.
The inventory subledger must reconcile to the General Ledger.
```

Every posted inventory transaction must remain traceable:

```text
Source Document
→ Stock Movement
→ Valuation
→ Journal Entry
→ Financial Statements
```

Inventory is the foundation for Manufacturing, but it remains a reusable Ledgora module across all relevant editions.
