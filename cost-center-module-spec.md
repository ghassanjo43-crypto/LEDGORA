# Cost Center Module Specification

## Objective

Build a production-quality **Cost Center module** in the existing React + TypeScript IFRS bookkeeping application.

The module must provide centralized management of organizational cost centers and consistent cost-center tagging across:

- General Journal
- General Ledger
- Invoices
- Credit notes
- Receipts
- Bills
- Supplier credits
- Payments
- Expenses
- Payroll entries
- Fixed assets
- Inventory transactions where available
- Budgets
- Trial Balance
- Income Statement
- Cash Flow Statement
- Management reports
- Statements of account where internal dimensions are shown
- Tax reports where dimensional analysis is required

The application already contains or is expected to contain:

- Entities / companies
- Chart of Accounts
- General Journal and General Ledger
- Customers and suppliers
- Sales and purchasing modules
- Projects and departments where available
- Tax codes
- Currencies
- Zustand stores
- Zod validation
- LocalStorage persistence
- Existing report, drill-down, print/PDF, CSV, and Excel utilities
- Ledgerly ERP design system

The Cost Center module must be the single source of truth for cost-center master data, hierarchy, validation, allocation, budgeting, and reporting.

Do not duplicate cost-center definitions inside transaction modules.

Do not store separate accounting balances that can drift from posted journal lines.

---

# 1. Core Purpose

The module must support:

1. Cost-center master records
2. Multi-level hierarchy
3. Parent and child cost centers
4. Entity-specific cost centers
5. Shared reporting groups where appropriate
6. Active, inactive, and archived statuses
7. Effective dates
8. Cost-center managers
9. Budget ownership
10. Transaction tagging
11. Required-dimension rules
12. Default cost-center resolution
13. Split allocation across cost centers
14. Percentage-based allocation
15. Fixed-amount allocation
16. Statistical drivers
17. Recurring allocation rules
18. Allocation journal posting
19. Budget versus actual reporting
20. Cost-center Income Statement
21. Cost-center Trial Balance
22. Cost-center General Ledger
23. Comparative reporting
24. Period locking
25. Historical snapshots
26. Audit history
27. CSV/Excel import and export
28. Drill-down to source documents
29. Multi-entity reporting with proper separation
30. Integration with projects and departments without confusing the dimensions

---

# 2. Navigation

Under Accounting or Settings add:

```text
Accounting
- Cost Centers
- Cost Center Budgets
- Cost Allocations
- Cost Center Reports
```

Alternative Settings placement:

```text
Settings
- Organization
- Cost Centers
- Departments
- Projects
```

Routes:

```text
/accounting/cost-centers
/accounting/cost-centers/new
/accounting/cost-centers/:costCenterId
/accounting/cost-centers/:costCenterId/edit

/accounting/cost-center-budgets
/accounting/cost-center-allocations
/accounting/reports/cost-centers
```

Optional route:

```text
/accounting/reports/cost-center/:costCenterId
```

---

# 3. Cost Center Model

Create `src/types/costCenter.ts`.

```ts
export type CostCenterStatus =
  | "active"
  | "inactive"
  | "archived"

export type CostCenterType =
  | "operating"
  | "administrative"
  | "sales"
  | "production"
  | "service"
  | "support"
  | "shared"
  | "corporate"
  | "custom"

export type CostCenter = {
  id: string
  entityId: string

  code: string
  name: string
  description?: string

  type: CostCenterType
  status: CostCenterStatus

  parentId?: string
  hierarchyPath: string[]
  level: number
  sortOrder: number

  managerUserId?: string
  managerName?: string

  effectiveFrom: string
  effectiveTo?: string

  defaultCurrencyCode?: string

  isPostingAllowed: boolean
  isBudgetEnabled: boolean
  isAllocationSource: boolean
  isAllocationTarget: boolean

  reportingGroupId?: string

  notes?: string

  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
}
```

---

# 4. Cost Center Hierarchy

Support a hierarchy such as:

```text
Corporate
├── Administration
│   ├── Finance
│   ├── Human Resources
│   └── Legal
├── Sales
│   ├── Domestic Sales
│   └── International Sales
├── Operations
│   ├── Production
│   ├── Logistics
│   └── Quality Control
└── Research and Development
```

Rules:

- A cost center may have one parent
- Circular parent relationships are prohibited
- Child cost centers inherit entity
- Parent and child effective dates must be compatible
- Posting may be allowed only at leaf level according to configuration
- Archived parents remain visible historically
- Moving a cost center must update descendant hierarchy paths

Create:

```ts
buildCostCenterTree(...)
validateCostCenterHierarchy(...)
moveCostCenter(...)
getCostCenterDescendants(...)
getCostCenterAncestors(...)
```

---

# 5. Posting versus Summary Cost Centers

Support:

```ts
isPostingAllowed: boolean
```

Recommended:

- Summary/header cost centers: no direct posting
- Leaf cost centers: posting allowed

Account and transaction pickers must clearly disable non-posting cost centers.

Do not allow journal lines to post directly to a summary cost center unless policy explicitly permits it.

---

# 6. Cost Center Code

Require a unique code per entity.

Examples:

```text
CC-ADMIN
CC-FIN
CC-HR
CC-SALES-DOM
CC-SALES-INT
CC-PROD
```

Validation:

- Unique within entity
- Case-insensitive uniqueness
- Stable historical code
- Code changes require permission and audit record
- Archived codes cannot be reused if historical records exist

Create:

```ts
checkDuplicateCostCenterCode(...)
```

---

# 7. Effective Dating

Support:

```text
Effective from
Effective to
```

Rules:

- Transactions before effective start are blocked
- Transactions after effective end are blocked
- Historical posted transactions remain visible
- Inactive/archived cost centers cannot be selected on new transactions
- Existing open documents using an expired cost center must warn before posting

Create:

```ts
isCostCenterActiveOnDate(...)
```

---

# 8. Cost Center Assignment Model

Journal lines and source-document lines should store:

```ts
export type CostCenterAssignment = {
  costCenterId: string
  percentage?: number
  amount?: number
}
```

For a single assignment:

```text
percentage = 100%
```

For split allocation:

```text
Finance: 30%
Operations: 70%
```

The sum must equal 100% or the assigned amount total.

---

# 9. Split Cost Center Allocation

Support multiple cost centers on one source line.

Example:

```text
Office rent expense: 10,000

Administration: 40% = 4,000
Sales:          35% = 3,500
Operations:     25% = 2,500
```

The posting engine may create separate journal lines by cost center.

Do not store only one cost center when the economic allocation is split.

Create:

```ts
allocateAmountAcrossCostCenters(...)
validateCostCenterSplit(...)
```

---

# 10. Allocation Methods

Create:

```ts
export type CostCenterAllocationMethod =
  | "percentage"
  | "fixed-amount"
  | "headcount"
  | "floor-area"
  | "revenue"
  | "usage"
  | "units-produced"
  | "custom-driver"
```

## Percentage

User-defined percentages.

## Fixed amount

Explicit amounts.

## Headcount

Allocate using employee counts.

## Floor area

Allocate occupancy costs.

## Revenue

Allocate shared costs based on revenue.

## Usage

Allocate by measured consumption.

## Units produced

Allocate production overhead.

## Custom driver

Use a defined numerical driver.

The first release should support percentage and fixed amount. Other drivers may be added when reliable source data exists.

---

# 11. Allocation Rule Model

Create:

```ts
export type CostCenterAllocationRule = {
  id: string
  entityId: string

  code: string
  name: string
  description?: string

  status:
    | "draft"
    | "active"
    | "inactive"
    | "archived"

  sourceCostCenterId?: string
  sourceAccountIds?: string[]
  sourceAccountTypeIds?: string[]

  method: CostCenterAllocationMethod

  targets: CostCenterAllocationTarget[]

  frequency:
    | "manual"
    | "monthly"
    | "quarterly"
    | "annual"

  effectiveFrom: string
  effectiveTo?: string

  allocationAccountId?: string
  clearingAccountId?: string

  createdAt: string
  updatedAt: string
}
```

Target:

```ts
export type CostCenterAllocationTarget = {
  costCenterId: string
  percentage?: number
  fixedAmount?: number
  driverValue?: number
  sortOrder: number
}
```

---

# 12. Allocation Run

Create:

```ts
export type CostCenterAllocationRun = {
  id: string
  entityId: string
  ruleId: string

  periodStart: string
  periodEnd: string
  postingDate: string

  status:
    | "draft"
    | "reviewed"
    | "posted"
    | "reversed"

  sourceAmount: number
  allocatedAmount: number
  unallocatedAmount: number

  lines: CostCenterAllocationRunLine[]

  journalEntryId?: string
  reversalJournalEntryId?: string

  createdAt: string
  updatedAt: string
  postedAt?: string
  reversedAt?: string
}
```

Run line:

```ts
export type CostCenterAllocationRunLine = {
  id: string

  sourceCostCenterId?: string
  sourceAccountId: string

  targetCostCenterId: string
  targetAccountId: string

  basisValue?: number
  percentage?: number

  debitAmount: number
  creditAmount: number

  memo?: string
}
```

---

# 13. Allocation Accounting

Example: reallocate shared IT expense.

Original balance:

```text
Shared Services / IT Expense: 10,000
```

Allocation:

```text
Administration: 30%
Sales:          40%
Operations:     30%
```

Journal approach:

```text
Dr IT Expense — Administration      3,000
Dr IT Expense — Sales               4,000
Dr IT Expense — Operations          3,000
    Cr IT Expense — Shared Services       10,000
```

Alternatively use a clearing account if required.

The allocation journal must net to zero at entity level.

Do not duplicate entity expense.

---

# 14. Allocation Validation

Require:

- Entity
- Active rule
- Valid period
- Valid source cost center/account
- Valid target cost centers
- Posting-enabled targets
- Percentages total 100% for percentage method
- Fixed amounts equal allocated source amount
- Valid posting date
- Open accounting period
- Balanced journal
- No duplicate posted allocation run for same rule/period unless reversed

Block:

- Circular allocation
- Source also receiving duplicated allocation without design
- Archived target
- Negative percentages
- Percentage above 100
- Missing allocation basis
- Invalid account
- Locked period

---

# 15. Reversal of Allocation

Create:

```ts
reverseCostCenterAllocationRun(...)
```

Reversal must:

- Require reason
- Reverse exact original journal lines
- Preserve original run
- Link reversal journal
- Mark run reversed
- Allow corrected replacement

Do not reconstruct approximate values.

---

# 16. Transaction Integration

Cost-center assignment must be available on:

- General Journal lines
- Invoice lines
- Credit-note lines
- Bill lines
- Supplier-credit lines
- Receipt and payment lines where relevant
- Expense transactions
- Payroll journal lines
- Asset acquisition and depreciation lines
- Inventory issue/consumption lines where available

Use one shared:

```text
CostCenterPicker
```

Do not implement separate inconsistent selectors per module.

---

# 17. General Journal Integration

Each journal line may have:

```ts
costCenterId?: string
costCenterAssignments?: CostCenterAssignment[]
```

Rules:

- Single or split assignment
- Cost center must belong to journal entity
- Must be active on posting date
- Must be posting-enabled
- Required-dimension rules must pass
- Split amounts must reconcile to original line amount

Journal remains balanced financially after splitting.

---

# 18. Invoice Integration

Sales invoice lines may carry a cost center for management reporting.

Typical uses:

- Sales branch
- Business unit
- Sales department
- Delivery center

Do not force a cost center on receivable control lines unless journal metadata propagation requires it.

Revenue line cost-center assignment should flow to the generated journal.

Tax control lines normally inherit or omit cost center according to policy.

---

# 19. Credit Note Integration

Linked credit notes should default to original invoice line cost centers.

For partial credits, reverse cost-center values proportionally or by selected line.

Do not default to the customer’s current cost center when reversing a historical invoice.

---

# 20. Bill Integration

Bill lines should allow:

- Expense cost center
- Asset cost center where useful
- Inventory cost center where policy permits
- Split allocation

The selected cost center must flow to generated expense/asset/inventory journal lines.

AP control lines normally use no cost center unless configured.

---

# 21. Supplier Credit Integration

Supplier credits linked to bills should inherit the original bill line cost center.

Do not use current defaults for historical reversal without explicit user change.

---

# 22. Receipt and Payment Integration

Ordinary settlement of receivables/payables usually does not create P&L cost-center activity.

Rules:

- Bank/cash lines normally omit cost center
- Receivable/payable control lines normally omit cost center
- Bank fees, discounts, FX, withholding, and direct expense/payment lines may require cost centers
- Customer refunds normally inherit the original sales cost center only if policy requires it

Do not tag every cash settlement with an arbitrary cost center.

---

# 23. Payroll Integration

Payroll journal lines should support cost-center allocation by:

- Employee home cost center
- Department
- Timesheet distribution
- Project allocation
- Manual override

Example:

```text
Salary expense:
Finance 40%
Operations 60%
```

Do not post payroll liability or bank lines to cost centers unless policy requires it.

---

# 24. Fixed Asset Integration

Asset acquisition may have:

- Owning cost center
- Physical location cost center
- Depreciation expense cost center

Depreciation journals should post expense to the assigned cost center.

Historical asset cost-center transfers should preserve audit history.

---

# 25. Inventory Integration

Where inventory exists, cost centers may apply to:

- Consumption
- Internal issue
- Production overhead
- Warehouse operations
- Cost of goods sold analysis

Inventory balance-sheet control accounts may omit cost centers while expense/COGS lines carry them according to policy.

---

# 26. Required Dimension Rules

Create:

```ts
export type CostCenterRequirementRule = {
  id: string
  entityId: string

  accountIds?: string[]
  accountTypeIds?: string[]

  transactionTypes?: string[]

  requirement:
    | "required"
    | "optional"
    | "prohibited"

  effectiveFrom: string
  effectiveTo?: string

  status: "active" | "inactive"
}
```

Examples:

- Operating expenses: required
- Revenue: required
- Bank accounts: prohibited
- Trade receivables/payables: optional or prohibited
- Tax accounts: prohibited
- Equity accounts: optional

Create:

```ts
resolveCostCenterRequirement(...)
validateCostCenterRequirement(...)
```

---

# 27. Default Cost Center Resolution

Create:

```ts
resolveDefaultCostCenter(...)
```

Priority may include:

1. Explicit line selection
2. Product/service default
3. Employee default
4. Supplier/customer default
5. Project default
6. Department default
7. Account default
8. Entity default
9. No default

Do not override an explicit user selection.

Show the source of the default.

---

# 28. Account Defaults

Optional account metadata:

```ts
defaultCostCenterId?: string
costCenterRequirement?: "required" | "optional" | "prohibited"
```

This should assist entry but not replace centralized validation rules.

---

# 29. Customer and Supplier Defaults

Recommended optional fields:

```ts
defaultSalesCostCenterId?: string
defaultPurchaseCostCenterId?: string
```

These are defaults only.

Do not assume a supplier belongs permanently to one cost center when individual bills may differ.

---

# 30. Product and Service Defaults

Optional:

```ts
salesCostCenterId?: string
purchaseCostCenterId?: string
```

Useful for revenue and expense classification.

---

# 31. Projects versus Cost Centers

Keep dimensions distinct.

## Cost center

Answers:

```text
Which organizational unit is responsible for the cost or revenue?
```

## Project

Answers:

```text
Which temporary initiative, contract, or job generated the activity?
```

A transaction line may have both:

```text
Cost center: Engineering
Project: Solar Plant Project
```

Do not merge project and cost-center IDs.

---

# 32. Departments versus Cost Centers

A department may be an HR organizational structure.

A cost center is an accounting/management reporting dimension.

They may map one-to-one or many-to-one but must remain configurable.

Create optional mapping:

```ts
departmentId?: string
defaultCostCenterId?: string
```

---

# 33. Budgets

Create cost-center budgets.

```ts
export type CostCenterBudget = {
  id: string
  entityId: string

  name: string
  fiscalYear: number
  scenario:
    | "base"
    | "approved"
    | "forecast"
    | "reforecast"
    | "custom"

  currencyCode: string

  status:
    | "draft"
    | "submitted"
    | "approved"
    | "locked"
    | "archived"

  lines: CostCenterBudgetLine[]

  createdAt: string
  updatedAt: string
  approvedAt?: string
}
```

Budget line:

```ts
export type CostCenterBudgetLine = {
  id: string

  costCenterId: string
  accountId: string

  month: number

  amount: number

  notes?: string
}
```

---

# 34. Budget Periods

Support:

- Monthly
- Quarterly
- Annual

Recommended first release:

```text
Monthly values with annual total
```

Allow:

- Copy prior year
- Spread annual amount evenly
- Apply seasonal distribution
- Apply growth percentage
- Import CSV/Excel
- Export CSV/Excel

---

# 35. Budget Validation

Require:

- Entity
- Fiscal year
- Scenario
- Currency
- Active cost center
- Valid account
- Valid period
- Non-duplicate line for same cost center/account/month
- Valid approval workflow

Do not post budgets to General Ledger.

Budgets are management data.

---

# 36. Budget versus Actual

Create report:

```text
Cost Center Budget vs Actual
```

Columns:

- Cost center
- Account
- Budget
- Actual
- Variance
- Variance %
- Prior year actual
- Forecast
- YTD values

Formula:

```text
Variance = Actual − Budget
```

For expenses, allow favorable/unfavorable interpretation.

Do not use one sign interpretation for both revenue and expense without account-type logic.

---

# 37. Cost Center Income Statement

Create report:

```text
Income Statement by Cost Center
```

Show:

- Revenue
- Cost of sales
- Gross profit
- Operating expenses
- EBITDA
- Depreciation
- Operating profit
- Finance income/expense where allocated
- Net result where appropriate

Columns may include:

- One cost center
- Multiple cost centers side by side
- Parent cost center with descendants
- Actual vs budget
- Current vs prior period

Use posted journal lines as source.

---

# 38. Cost Center Trial Balance

Create:

```text
Trial Balance by Cost Center
```

Filters:

- Entity
- Date range
- Cost center
- Include descendants
- Account range
- Currency
- Posted/draft
- Zero balances

Show:

- Opening debit
- Opening credit
- Period debit
- Period credit
- Closing debit
- Closing credit

---

# 39. Cost Center General Ledger

Create:

```text
General Ledger by Cost Center
```

Show:

- Date
- Journal number
- Source document
- Account
- Description
- Debit
- Credit
- Running balance
- Cost center
- Project
- Customer/supplier
- Drill-down

---

# 40. Cost Center Summary Report

Show:

- Total revenue
- Total direct cost
- Gross contribution
- Operating expense
- Allocated shared cost
- Net contribution
- Budget
- Variance

Parent cost centers should aggregate descendants.

Do not double count parent and child direct postings when posting to parent is disabled.

---

# 41. Comparative Reporting

Support:

- Cost center vs cost center
- Current period vs prior period
- Actual vs budget
- Actual vs forecast
- Entity vs entity only in reporting layer with proper currency conversion
- Parent group comparisons

---

# 42. Allocation Reporting

Show:

- Rule
- Period
- Source amount
- Target cost centers
- Percentages
- Allocated amount
- Unallocated amount
- Journal number
- Status
- Reversal

Drill down to source balances and allocation journals.

---

# 43. Currency Integration

Cost-center reports are primarily in entity base currency.

Optional:

- Original transaction currency
- Base currency
- Reporting currency

Do not add different currencies without conversion.

Use posted historical base amounts.

Budget currency may differ only if conversion logic exists.

---

# 44. Tax Integration

Tax control accounts are normally excluded from cost-center P&L reporting.

Taxable base and tax may carry cost-center metadata for analysis where required.

Do not include VAT receivable/payable as operating cost-center expense unless tax is non-recoverable and posted to expense.

---

# 45. Cash Flow Integration

Cost center is a management dimension.

Cash Flow Statement classification is driven by accounts and transaction nature.

Optional cash-flow-by-cost-center report may use source counterpart lines.

Do not assign all bank lines directly to cost centers and double count cash flows.

---

# 46. Period Locking

When accounting period is locked:

- Posted cost-center assignments are immutable
- Allocation runs cannot post
- Reversals require reopened period or adjustment period
- Budget edits follow budget status separately

Manual override requires:

- Permission
- Reason
- Audit record

---

# 47. Historical Snapshots

Posted documents and journal lines should retain:

- Cost center ID
- Cost center code
- Cost center name
- Hierarchy path at posting time, if needed for historical reporting

Recommended snapshot:

```ts
export type CostCenterSnapshot = {
  costCenterId: string
  code: string
  name: string
  hierarchyPath: string[]
  capturedAt: string
}
```

Later renaming or hierarchy movement must not make historical documents misleading.

Reports may support:

- Current hierarchy
- Historical hierarchy

Clearly label the basis.

---

# 48. Cost Center Picker

Create a reusable picker.

Requirements:

- Search by code/name
- Show hierarchy indentation
- Show entity
- Show active status
- Disable non-posting nodes
- Filter by effective date
- Keyboard navigation
- Portal to `document.body`
- Collision-aware positioning
- Internal scrolling
- High z-index
- Clear selection
- Optional “include inactive” for historical search

Return stable string IDs matching validation.

---

# 49. Cost Center List

Columns:

- Code
- Name
- Type
- Parent
- Level
- Manager
- Posting allowed
- Budget enabled
- Effective dates
- Status
- Actual YTD
- Budget YTD
- Variance

Filters:

- Entity
- Status
- Type
- Parent
- Posting allowed
- Budget enabled
- Manager
- Effective on date

Actions:

- View
- Edit
- Add child
- Move
- Activate
- Deactivate
- Archive
- View report

---

# 50. Cost Center Editor

Sections:

## General

- Entity
- Code
- Name
- Description
- Type
- Status

## Hierarchy

- Parent
- Level
- Sort order
- Posting allowed

## Ownership

- Manager
- Budget owner

## Effective dates

- Effective from
- Effective to

## Capabilities

- Budget enabled
- Allocation source
- Allocation target

## Defaults and mappings

- Reporting group
- Default currency
- Department mapping
- Project mapping where appropriate

Actions:

- Save draft
- Activate
- Deactivate
- Archive
- Cancel

---

# 51. Import and Export

Support CSV/Excel import.

Fields:

- Entity
- Code
- Name
- Description
- Type
- Parent code
- Manager
- Posting allowed
- Budget enabled
- Effective from
- Effective to
- Status

Import validation:

- Duplicate codes
- Unknown parents
- Circular hierarchy
- Invalid dates
- Invalid entity
- Invalid booleans
- Parent-child entity mismatch

Provide a dry-run preview before commit.

---

# 52. Validation

Create:

```ts
validateCostCenterDraft(...)
validateCostCenterForActivation(...)
validateCostCenterForTransaction(...)
validateCostCenterSplit(...)
validateCostCenterAllocationRule(...)
validateCostCenterAllocationRun(...)
```

Activation requires:

- Entity
- Unique code
- Name
- Type
- Effective date
- Valid parent
- No hierarchy cycle
- Compatible parent dates

Transaction validation requires:

- Correct entity
- Active on posting date
- Posting allowed
- Requirement rule satisfied
- Split totals reconcile
- No archived cost center

---

# 53. Permissions

Suggested permissions:

- View cost centers
- Create cost centers
- Edit cost centers
- Activate/deactivate cost centers
- Archive cost centers
- Move cost centers
- Manage requirement rules
- Manage allocation rules
- Run allocations
- Post allocations
- Reverse allocations
- Manage budgets
- Approve budgets
- View cost-center reports
- Export reports
- Override cost-center validation

---

# 54. Audit Trail

Record:

- Cost center created
- Code changed
- Name changed
- Parent changed
- Manager changed
- Posting flag changed
- Effective dates changed
- Activated
- Deactivated
- Archived
- Requirement rule changed
- Allocation rule created/changed
- Allocation run posted
- Allocation run reversed
- Budget created
- Budget approved
- Budget locked
- Validation override used

Do not overwrite historical audit records.

---

# 55. Recommended Files

Adapt to actual project conventions.

```text
src/
  types/
    costCenter.ts
    costCenterBudget.ts
    costCenterAllocation.ts

  store/
    costCenterStore.ts
    costCenterBudgetStore.ts
    costCenterAllocationStore.ts

  lib/
    costCenterHierarchy.ts
    costCenterValidation.ts
    costCenterResolution.ts
    costCenterAllocation.ts
    costCenterAllocationPosting.ts
    costCenterBudget.ts
    costCenterReporting.ts
    costCenterSnapshots.ts
    costCenterImport.ts

  components/
    cost-centers/
      CostCenterList.tsx
      CostCenterEditor.tsx
      CostCenterDrawer.tsx
      CostCenterTree.tsx
      CostCenterPicker.tsx
      CostCenterSplitEditor.tsx
      CostCenterRequirementRules.tsx
      CostCenterBudgetEditor.tsx
      CostCenterBudgetTable.tsx
      CostCenterAllocationRuleEditor.tsx
      CostCenterAllocationRunEditor.tsx
      CostCenterReportFilters.tsx
      CostCenterIncomeStatement.tsx
      CostCenterTrialBalance.tsx
      CostCenterLedger.tsx

  pages/
    CostCentersPage.tsx
    CostCenterDetailsPage.tsx
    CostCenterBudgetsPage.tsx
    CostCenterAllocationsPage.tsx
    CostCenterReportsPage.tsx
```

Keep business logic outside React components.

---

# 56. Core Functions

Implement:

```ts
buildCostCenterTree(...)
validateCostCenterHierarchy(...)
moveCostCenter(...)
getCostCenterDescendants(...)
getCostCenterAncestors(...)
isCostCenterActiveOnDate(...)
checkDuplicateCostCenterCode(...)
resolveDefaultCostCenter(...)
resolveCostCenterRequirement(...)
validateCostCenterRequirement(...)
allocateAmountAcrossCostCenters(...)
validateCostCenterSplit(...)
buildCostCenterAllocationRun(...)
buildCostCenterAllocationJournal(...)
postCostCenterAllocationRun(...)
reverseCostCenterAllocationRun(...)
calculateCostCenterBudgetActual(...)
buildCostCenterIncomeStatement(...)
buildCostCenterTrialBalance(...)
buildCostCenterLedger(...)
createCostCenterSnapshot(...)
```

---

# 57. Persistence

Use Zustand and LocalStorage consistently.

Persist:

- Cost centers
- Hierarchy
- Requirement rules
- Allocation rules
- Allocation runs
- Budget records
- Journal links
- Reversal links
- Audit metadata

Ensure refresh preserves:

- Cost center tree
- Draft edits
- Budget data
- Allocation runs
- Routes
- Filters
- Report settings

Do not persist derived balances as authoritative accounting data.

---

# 58. Acceptance Scenario 1 — Hierarchy

Create:

```text
Corporate
├── Administration
│   ├── Finance
│   └── Human Resources
└── Operations
    ├── Production
    └── Logistics
```

Expected:

- Parent nodes display totals from descendants
- Posting allowed only to leaf nodes
- Moving Logistics under Administration updates hierarchy path
- Historical posted journal snapshots remain unchanged

---

# 59. Acceptance Scenario 2 — Bill Split

Bill expense:

```text
Office rent: 10,000.00
```

Allocation:

```text
Administration: 40% = 4,000.00
Sales:          35% = 3,500.00
Operations:     25% = 2,500.00
```

Expected journal expense lines:

```text
Dr Rent expense — Administration     4,000.00
Dr Rent expense — Sales              3,500.00
Dr Rent expense — Operations         2,500.00
    Cr Trade payables                       10,000.00
```

Expected:

- Total debit 10,000
- Split equals source amount
- AP control line not duplicated
- Cost-center reports show correct amounts

---

# 60. Acceptance Scenario 3 — Shared Cost Allocation

Source:

```text
IT expense — Shared Services: 12,000.00
```

Rule:

```text
Administration: 25%
Sales:          35%
Operations:     40%
```

Journal:

```text
Dr IT expense — Administration       3,000.00
Dr IT expense — Sales                4,200.00
Dr IT expense — Operations           4,800.00
    Cr IT expense — Shared Services        12,000.00
```

Expected:

- Entity total expense unchanged
- Shared Services net allocation zero
- Target cost centers receive allocated expense
- Journal balanced
- Allocation run linked and reversible

---

# 61. Acceptance Scenario 4 — Budget versus Actual

Finance cost center:

```text
Annual budget: 120,000
YTD budget:     60,000
YTD actual:     66,000
Variance:        6,000 unfavorable
Variance %:        10%
```

Expected report:

- Correct sign interpretation for expense
- Drill-down from actual to journals
- Monthly and YTD view
- Approved budget remains immutable

---

# 62. Acceptance Scenario 5 — Required Dimension

Rule:

```text
Operating expense accounts → Cost center required
Bank accounts → Cost center prohibited
```

Journal:

```text
Dr Travel expense — no cost center
Cr Bank — no cost center
```

Expected:

- Posting blocked because travel expense lacks cost center
- Bank line remains valid without cost center
- User selects Finance cost center
- Journal posts successfully

---

# 63. Tests

Add tests for:

1. Unique code per entity
2. Same code in different entities follows policy
3. Circular hierarchy blocked
4. Parent-child entity mismatch blocked
5. Descendant paths update after move
6. Non-posting parent blocked on transactions
7. Inactive cost center blocked
8. Expired cost center blocked by date
9. Historical posted cost center remains visible
10. Cost center requirement rule works
11. Prohibited account rule works
12. Explicit selection overrides default
13. Account default resolution works
14. Supplier/customer default resolution works
15. Split percentages total 100
16. Split fixed amounts equal source
17. Split journal remains balanced
18. Bill split flows to posting
19. Invoice revenue cost center flows to posting
20. Credit note inherits original cost center
21. Supplier credit inherits original cost center
22. Receipt settlement does not create false P&L cost center
23. Payment bank line does not require cost center
24. Bank fee cost center requirement works
25. Allocation rule validation works
26. Allocation run totals correct
27. Allocation journal nets to zero at entity level
28. Duplicate allocation run blocked
29. Allocation reversal exact
30. Budget line uniqueness works
31. Budget approval locks changes
32. Budget versus actual correct
33. Expense variance sign correct
34. Revenue variance sign correct
35. Parent report aggregates descendants
36. No parent-child double counting
37. Cost-center Trial Balance correct
38. Cost-center General Ledger correct
39. Cost-center Income Statement correct
40. Multi-currency reports use base amounts
41. Tax control accounts excluded appropriately
42. Payroll split works
43. Asset depreciation cost center works
44. Historical snapshot remains unchanged after rename
45. Current hierarchy report works
46. Historical hierarchy report works
47. Import dry-run catches errors
48. LocalStorage hydration works
49. Empty state safe
50. Mobile editor works
51. Picker portal and scrolling work
52. Route refresh works

---

# 64. QA

Run:

- TypeScript typecheck
- Unit tests
- Production build
- Cost-center creation smoke test
- Hierarchy test
- Move test
- Required-dimension test
- Bill split test
- Invoice integration test
- Credit-note inheritance test
- Allocation rule test
- Allocation posting test
- Allocation reversal test
- Budget test
- Budget-vs-actual test
- Cost-center Income Statement test
- Cost-center Trial Balance test
- Cost-center Ledger test
- Import/export test
- LocalStorage hydration test
- Mobile-width test
- Picker scrolling test
- Route refresh test

Report:

- Files created
- Files modified
- Cost-center hierarchy implemented
- Posting rules implemented
- Default-resolution logic
- Split-allocation logic
- Allocation-journal logic
- Budget logic
- Reporting logic
- Acceptance-scenario results
- Tests
- Typecheck
- Production build
- Intentionally deferred items

---

# Core Accounting Rules

Cost center is a management-reporting dimension attached to posted journal activity.

It does not replace the account.

Example:

```text
Account: Rent expense
Cost center: Administration
```

Split allocation:

```text
One source amount
→ Multiple cost-center-tagged journal lines
→ Same total debit/credit
```

Shared-cost reallocation:

```text
Dr Expense — Target cost centers
    Cr Expense — Source cost center
```

The entity-level financial total must remain unchanged.

The module must preserve:

- Cost center ID
- Code
- Name
- Hierarchy
- Effective dates
- Posting eligibility
- Split assignments
- Allocation rules
- Allocation runs
- Budget records
- Journal links
- Historical snapshots
- Audit history

Historical posted transactions must not change merely because a cost center is renamed, moved, deactivated, or archived later.
