# Projects Module Specification

## Objective

Build a production-quality Projects module in the existing React + TypeScript IFRS bookkeeping application.

Reuse the existing:

- Entities
- Customers and suppliers
- Invoices, credit notes, receipts
- Bills, supplier credits, payments
- General Journal and General Ledger
- Cost centers, departments, tax codes, and currencies
- Zustand and LocalStorage persistence
- Zod validation
- Print/PDF, CSV, Excel, and drill-down utilities
- Ledgerly ERP design system

Do not create a separate accounting engine.

All actual project values must be derived from posted journal lines and linked source records.

---

## 1. Core capabilities

Support:

1. Customer projects
2. Internal projects
3. Capital projects
4. Construction projects
5. Service projects
6. Research projects
7. Fixed-price billing
8. Time-and-materials billing
9. Cost-plus billing
10. Milestone billing
11. Progress billing
12. Retainers
13. Project budgets
14. Time entries
15. Project expenses
16. Purchase commitments
17. Project invoices and bills
18. Revenue recognition
19. Work in progress
20. Unbilled revenue
21. Deferred revenue
22. Project profitability
23. Project cash flow
24. Budget versus actual
25. Project Income Statement
26. Project General Ledger
27. Multi-currency projects
28. Project closeout
29. Audit history

---

## 2. Navigation

Add:

```text
Projects
- All Projects
- Project Budgets
- Time & Expenses
- Project Billing
- Project Reports
```

Routes:

```text
/projects
/projects/new
/projects/:projectId
/projects/:projectId/edit
/projects/:projectId/budget
/projects/:projectId/billing
/projects/:projectId/reports
/projects/time-expenses
/projects/reports
```

Add `New Project` and `View Projects` to customer details.

---

## 3. Project types and billing methods

```ts
export type ProjectType =
  | "customer"
  | "internal"
  | "capital"
  | "research"
  | "construction"
  | "service"
  | "retainer"
  | "implementation"
  | "maintenance"
  | "custom"

export type ProjectBillingMethod =
  | "fixed-price"
  | "time-and-materials"
  | "cost-plus"
  | "milestone"
  | "progress"
  | "retainer"
  | "non-billable"

export type ProjectStatus =
  | "draft"
  | "planned"
  | "active"
  | "on-hold"
  | "completed"
  | "closed"
  | "cancelled"
  | "archived"
```

Rules:

- Active projects accept transactions.
- Completed projects allow final billing and adjustments.
- Closed, cancelled, and archived projects block new postings.
- Reopening requires permission and an audit reason.

---

## 4. Project model

Create `src/types/project.ts`.

```ts
export type Project = {
  id: string
  entityId: string

  code: string
  name: string
  description?: string

  type: ProjectType
  status: ProjectStatus
  billingMethod: ProjectBillingMethod

  customerId?: string
  primaryContactId?: string

  parentProjectId?: string
  projectManagerUserId?: string
  projectManagerName?: string

  contractNumber?: string
  purchaseOrderNumber?: string

  startDate: string
  expectedEndDate?: string
  actualEndDate?: string

  currencyCode: string
  exchangeRatePolicy:
    | "document-rate"
    | "project-fixed-rate"
    | "entity-default"

  fixedExchangeRate?: number

  contractValue?: number
  approvedChangeOrders?: number
  revisedContractValue?: number

  budgetRevenue?: number
  budgetCost?: number
  budgetHours?: number

  taxCodeId?: string

  defaultRevenueAccountId?: string
  defaultCostAccountId?: string
  wipAccountId?: string
  deferredRevenueAccountId?: string
  unbilledRevenueAccountId?: string
  retentionReceivableAccountId?: string
  projectAssetAccountId?: string

  defaultCostCenterId?: string
  departmentId?: string

  billable: boolean
  allowTimeEntries: boolean
  allowExpenses: boolean
  allowPurchases: boolean

  billingContactName?: string
  billingEmail?: string

  notes?: string
  tags?: string[]

  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
}
```

---

## 5. Project codes and hierarchy

Project code must be unique per entity.

Examples:

```text
PRJ-2026-001
DUBAI-HOTEL
RND-HER2-01
CAPEX-WAREHOUSE
```

Support parent projects and subprojects.

Rules:

- Circular hierarchy blocked
- Parent and child belong to the same entity
- Parent reports aggregate descendants
- Moving a project updates descendant paths
- Historical project snapshots remain unchanged

Create:

```ts
checkDuplicateProjectCode(...)
generateProjectCode(...)
buildProjectTree(...)
validateProjectHierarchy(...)
getProjectDescendants(...)
getProjectAncestors(...)
moveProject(...)
```

---

## 6. Reusable ProjectPicker

Create one shared picker.

Requirements:

- Search by code, name, customer, and manager
- Show hierarchy indentation
- Filter by entity and customer
- Disable closed/cancelled/archived projects
- Filter by posting date
- Keyboard navigation
- Portal to `document.body`
- Collision-aware position
- Internal scrolling
- High z-index
- Stable string IDs

---

## 7. Customer and supplier relationships

Customer projects require one customer.

Rules:

- Project invoice customer must match project customer unless authorized.
- Credit notes inherit the project from original invoice lines.
- Receipts inherit projects through invoice allocations.
- Customer statements may filter by project.

Optional project-supplier relation:

```ts
export type ProjectSupplier = {
  id: string
  projectId: string
  supplierId: string
  role?: string
  contractNumber?: string
  budgetAmount?: number
  currencyCode?: string
  createdAt: string
}
```

---

## 8. Project budget

Create `src/types/projectBudget.ts`.

```ts
export type ProjectBudget = {
  id: string
  projectId: string
  entityId: string

  name: string
  version: number
  scenario:
    | "original"
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

  budgetRevenue: number
  budgetCost: number
  budgetHours: number

  lines: ProjectBudgetLine[]

  approvedAt?: string
  approvedBy?: string

  createdAt: string
  updatedAt: string
}

export type ProjectBudgetLine = {
  id: string
  projectBudgetId: string

  category:
    | "revenue"
    | "labor"
    | "materials"
    | "subcontract"
    | "travel"
    | "overhead"
    | "equipment"
    | "other"

  accountId?: string
  costCenterId?: string

  month?: number
  date?: string

  quantity?: number
  rate?: number
  hours?: number

  amount: number
  notes?: string
}
```

Approved budget versions are immutable. New changes create new versions.

---

## 9. Budget calculations

Create:

```ts
calculateProjectBudgetTotals(...)
```

Show:

```text
Budget revenue
Budget direct cost
Budget gross profit
Budget gross margin %
Budget hours
Average billing rate
Average cost rate
```

Formulas:

```text
Gross profit = Revenue - Direct cost
Gross margin % = Gross profit / Revenue
```

Handle zero revenue safely.

---

## 10. Time entries

```ts
export type ProjectTimeEntry = {
  id: string
  entityId: string
  projectId: string

  employeeId?: string
  userId?: string

  date: string
  hours: number
  activityCode?: string
  description?: string

  billable: boolean
  approved: boolean

  billingRate?: number
  costRate?: number

  billableAmount: number
  costAmount: number

  invoiceId?: string
  billedAt?: string

  createdAt: string
  updatedAt: string
}
```

Rules:

- Hours must be positive
- Project must allow time entries
- Approved entries may be billed
- Billed entries cannot be materially changed
- Billing and cost rates must be snapshotted

---

## 11. Project expenses

```ts
export type ProjectExpenseEntry = {
  id: string
  entityId: string
  projectId: string

  employeeId?: string
  supplierId?: string

  date: string
  description: string

  accountId: string
  amount: number
  currencyCode: string
  baseAmount: number

  billable: boolean
  markupPercent?: number
  billableAmount?: number

  approved: boolean

  billId?: string
  paymentId?: string
  invoiceId?: string

  createdAt: string
  updatedAt: string
}
```

Where an expense originates from a bill, reference that bill line instead of creating a second accounting transaction.

---

## 12. Project accounting policy

```ts
export type ProjectAccountingPolicy = {
  entityId: string

  revenueRecognitionMethod:
    | "invoice"
    | "milestone"
    | "percentage-of-completion"
    | "cost-recovery"
    | "manual"

  costRecognitionMethod:
    | "expense-as-incurred"
    | "capitalize-to-wip"
    | "capitalize-to-asset"
    | "manual"

  timeCostSource:
    | "time-entry-estimate"
    | "payroll-journal"
    | "manual"

  allowUnapprovedTimeBilling: boolean
  allowUnapprovedExpenseBilling: boolean
}
```

Do not double count time-entry estimates and payroll journals.

---

## 13. Billing workspace

Show:

- Unbilled time
- Unbilled expenses
- Milestones ready to bill
- Contract value
- Approved change orders
- Revised contract value
- Previously billed
- Current billing
- Remaining billable value
- Retainer balance

Actions:

- Create draft invoice
- Select time entries
- Select expenses
- Select milestones
- Apply markup
- Preview billing
- Issue through existing invoice module

Do not create a separate invoice engine.

---

## 14. Time-and-materials billing

Formula:

```text
Approved billable hours × billing rate
+ Approved billable expenses
+ Approved markup
```

When invoice is issued:

- Link selected time and expenses
- Mark them billed
- Prevent duplicate billing
- Preserve project and source references

---

## 15. Fixed-price and milestone billing

Track:

```text
Original contract value
Approved change orders
Revised contract value
Billed to date
Remaining to bill
```

Do not allow cumulative billing above revised contract value without authorized override.

Milestone model:

```ts
export type ProjectMilestone = {
  id: string
  projectId: string

  code: string
  name: string
  description?: string

  plannedDate?: string
  completedDate?: string

  status:
    | "planned"
    | "in-progress"
    | "completed"
    | "cancelled"

  billingAmount?: number
  revenueRecognitionAmount?: number

  invoiceId?: string
  journalEntryId?: string

  createdAt: string
  updatedAt: string
}
```

Milestone completion and billing are separate events.

---

## 16. Cost-plus billing

Formula:

```text
Eligible posted cost + markup
```

Create:

```ts
calculateCostPlusBilling(...)
```

Rules:

- Use only eligible posted costs
- Exclude non-billable cost
- Prevent duplicate billing
- Preserve source lines
- Apply category-specific markup where configured

---

## 17. Retainers

A retainer should normally be deferred until earned.

Possible accounting:

```text
Dr Trade receivables
    Cr Deferred revenue
```

When earned:

```text
Dr Deferred revenue
    Cr Revenue
```

Do not recognize retainer cash automatically as revenue.

---

## 18. Change orders

```ts
export type ProjectChangeOrder = {
  id: string
  projectId: string

  changeOrderNumber: string
  description: string

  status:
    | "draft"
    | "submitted"
    | "approved"
    | "rejected"
    | "cancelled"

  revenueChange: number
  costChange: number
  scheduleImpactDays?: number

  approvedAt?: string
  approvedBy?: string

  createdAt: string
  updatedAt: string
}
```

Approved change orders update revised contract value and forecast cost.

Original contract value remains unchanged.

---

## 19. Revenue recognition

Support:

```ts
export type RevenueRecognitionMethod =
  | "invoice"
  | "milestone"
  | "percentage-of-completion"
  | "cost-recovery"
  | "manual"
```

Keep distinct:

```text
Billed revenue
Recognized revenue
Cash collected
```

Do not assume they are equal.

---

## 20. Percentage of completion

Use cost-to-cost method:

```text
Completion % =
Actual eligible cost to date
/ Latest estimated total eligible cost
```

```text
Cumulative recognized revenue =
Revised contract value × Completion %
```

```text
Current-period revenue =
Cumulative recognized revenue
- Prior recognized revenue
```

Requirements:

- Completion between 0% and 100%
- Do not exceed revised contract value
- Use decimal-safe calculations
- Require review before posting

---

## 21. Revenue recognition run

```ts
export type ProjectRevenueRecognitionRun = {
  id: string
  entityId: string
  projectId: string

  periodStart: string
  periodEnd: string
  postingDate: string

  method: RevenueRecognitionMethod

  contractValue: number
  revisedContractValue: number

  actualCostToDate: number
  estimatedCostToComplete: number
  estimatedTotalCost: number

  completionPercent: number

  cumulativeRevenueRecognized: number
  priorRevenueRecognized: number
  currentRevenueToRecognize: number

  billedToDate: number
  unbilledRevenue: number
  deferredRevenue: number

  status:
    | "draft"
    | "reviewed"
    | "posted"
    | "reversed"

  journalEntryId?: string
  reversalJournalEntryId?: string

  createdAt: string
  updatedAt: string
}
```

Post only the current-period adjustment, not the cumulative amount again.

---

## 22. Work in progress

For projects configured to capitalize cost:

```text
Dr Work in progress
    Cr Expense / Payroll clearing / Inventory
```

On release:

```text
Dr Cost of sales
    Cr Work in progress
```

Do not capitalize projects configured as expense-as-incurred.

---

## 23. Unbilled and deferred revenue

When recognized revenue exceeds billing:

```text
Dr Unbilled revenue / Contract asset
    Cr Revenue
```

When billing exceeds recognition:

```text
Cr Deferred revenue / Contract liability
```

Use centralized account mappings and one consistent posting policy.

---

## 24. Revenue recognition validation and reversal

Validate:

- Active project
- Open period
- Valid method
- Valid contract value
- Estimated total cost where required
- Valid WIP/unbilled/deferred accounts
- No duplicate period run
- Balanced journal

Create:

```ts
buildProjectRevenueRecognitionRun(...)
buildProjectRevenueRecognitionJournal(...)
postProjectRevenueRecognition(...)
reverseProjectRevenueRecognitionRun(...)
```

Reversal must use exact original journal lines.

---

## 25. Invoice integration

Invoice header or lines may carry a project.

Rules:

- Customer must match project customer unless authorized
- Revenue lines carry project metadata
- Receivable control lines normally omit project or carry metadata only
- Tax lines follow tax policy
- Invoice updates billed-to-date
- Invoice does not necessarily equal recognized revenue

---

## 26. Credit-note integration

Linked credit notes inherit:

- Project ID
- Original project line
- Revenue account
- Tax snapshot
- Cost center where relevant

Credit note reduces billed-to-date.

Revenue-recognition effect follows project policy.

---

## 27. Receipt integration

Project cash collected is derived from receipt allocations to project invoices.

Do not assign the full receipt to one project when the receipt covers several projects.

---

## 28. Bill and supplier-credit integration

Bill lines may carry project.

Rules:

- Expense/asset/inventory lines carry project
- AP control line normally omits project
- Bill contributes to project actual cost
- Supplier credits inherit original bill project and reduce project cost

---

## 29. Payment integration

Project cash outflow is derived from payment allocations to project-linked bills.

Do not assign a multi-bill payment entirely to one project.

---

## 30. General Journal integration

Journal lines may include:

```ts
projectId?: string
```

Validate:

- Entity compatibility
- Project active on posting date
- Closed/cancelled project blocked
- Project requirement rule satisfied
- Account/project combination valid

---

## 31. Project requirement rules

```ts
export type ProjectRequirementRule = {
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

- Project revenue accounts: required
- Direct project cost accounts: required
- Bank accounts: prohibited
- Tax control accounts: prohibited
- AR/AP control accounts: optional or prohibited

---

## 32. Cost center integration

Project and cost center remain separate dimensions.

Example:

```text
Project: Dubai Hotel Conversion
Cost center: Engineering
```

Support reports by both dimensions.

Do not merge their IDs or master data.

---

## 33. Currency and tax integration

Project reports may show contract currency and entity base currency.

Rules:

- Preserve document exchange-rate snapshots
- Do not combine currencies without conversion
- Tax calculations use the centralized Tax Code module
- Recoverable tax is not project cost
- Non-recoverable tax may be project cost

---

## 34. Commitments

```ts
export type ProjectCommitment = {
  id: string
  projectId: string

  sourceType:
    | "purchase-order"
    | "subcontract"
    | "manual"

  sourceId?: string
  supplierId?: string

  committedAmount: number
  invoicedAmount: number
  remainingCommitment: number

  currencyCode: string
  baseAmount: number

  status:
    | "open"
    | "partially-used"
    | "fully-used"
    | "cancelled"

  createdAt: string
  updatedAt: string
}
```

Commitments are management data unless encumbrance accounting is implemented.

---

## 35. Profitability

```ts
export type ProjectProfitability = {
  projectId: string

  contractValue: number
  revisedContractValue: number

  billedRevenue: number
  recognizedRevenue: number
  cashCollected: number

  actualCost: number
  committedCost: number
  forecastCostToComplete: number
  estimatedTotalCost: number

  grossProfit: number
  grossMarginPercent: number

  forecastProfit: number
  forecastMarginPercent: number

  unbilledRevenue: number
  deferredRevenue: number
  wipBalance: number

  receivableBalance: number
  payableBalance: number

  generatedAt: string
}
```

Formulas:

```text
Gross profit = Recognized revenue - Actual cost
Gross margin % = Gross profit / Recognized revenue
Forecast profit = Revised contract value - Estimated total cost
Forecast margin % = Forecast profit / Revised contract value
```

---

## 36. Project cash flow

Calculate:

```text
Cash inflow =
Receipts allocated to project invoices
+ Customer advances assigned to project

Cash outflow =
Payments allocated to project bills
+ Direct project cash expenses
```

Do not treat invoice or bill posting as cash movement.

---

## 37. Dashboard

Show:

- Contract value
- Approved changes
- Revised contract value
- Billed to date
- Recognized revenue
- Cash collected
- Actual cost
- Committed cost
- Estimated cost to complete
- Forecast final cost
- Gross profit and margin
- WIP
- Unbilled revenue
- Deferred revenue
- Receivable and payable balances
- Budget vs actual hours
- Completion percentage
- Milestones
- Overdue invoices
- Upcoming bills

---

## 38. Project list

Columns:

- Code
- Name
- Customer
- Type
- Billing method
- Manager
- Start/end dates
- Contract value
- Recognized revenue
- Actual cost
- Gross margin
- Completion %
- Status

Filters:

- Entity
- Customer
- Status
- Type
- Billing method
- Manager
- Currency
- Over budget
- Low margin
- Overdue
- Unbilled revenue
- Deferred revenue

---

## 39. Project detail tabs

```text
Overview
Financials
Budget
Billing
Time
Expenses
Bills
Invoices
Receipts
Payments
Milestones
Change Orders
Commitments
Revenue Recognition
Reports
Audit Trail
```

Every figure must drill down to source records.

---

## 40. Project reports

Create:

1. Project Profitability
2. Project Income Statement
3. Project General Ledger
4. Budget vs Actual
5. Billing Summary
6. Revenue Recognition Summary
7. WIP Report
8. Unbilled Revenue Report
9. Deferred Revenue Report
10. Time Utilization
11. Expense Summary
12. Commitments Report
13. Cash Flow by Project
14. Project Aging
15. Project by Cost Center
16. Customer Projects Summary

---

## 41. Project Income Statement

Show:

- Recognized revenue
- Direct labor
- Materials
- Subcontracts
- Travel
- Other direct cost
- Allocated overhead
- Gross profit
- Gross margin
- Operating contribution

Use posted journal lines.

Avoid double counting WIP capitalization and release.

---

## 42. Project General Ledger

Show:

- Date
- Journal number
- Source document
- Account
- Description
- Debit
- Credit
- Running balance
- Project
- Cost center
- Party
- Currency
- Drill-down

---

## 43. Project aging

AR aging by project:

```text
Current
1–30
31–60
61–90
91–120
Over 120
```

Use outstanding balances after credit notes and receipts.

---

## 44. Customer project statement

Optional customer-facing report:

- Project details
- Contract value
- Change orders
- Invoices
- Credit notes
- Receipts
- Outstanding balance
- Milestones
- Progress
- Billing summary

Do not expose internal cost or profit unless explicitly enabled.

---

## 45. Project closeout

Before close, validate:

- No unbilled approved time or expenses
- Open commitments reviewed
- Revenue recognition complete
- WIP reviewed
- Unbilled/deferred balances reviewed
- Final billing status known
- Outstanding receivables/payables disclosed
- Final forecast completed

Create:

```ts
validateProjectForClose(...)
closeProject(...)
reopenProject(...)
```

---

## 46. Historical snapshots

Posted documents preserve:

```ts
export type ProjectSnapshot = {
  projectId: string
  code: string
  name: string
  customerId?: string
  billingMethod: ProjectBillingMethod
  currencyCode: string
  capturedAt: string
}
```

Later renaming or closure must not rewrite historical documents.

---

## 47. Validation

Create:

```ts
validateProjectDraft(...)
validateProjectForActivation(...)
validateProjectForTransaction(...)
validateProjectBudget(...)
validateProjectBilling(...)
validateRevenueRecognitionRun(...)
validateProjectForClose(...)
```

Activation requires:

- Entity
- Unique code
- Name
- Type
- Start date
- Currency
- Billing method
- Customer for customer project
- Required account mappings
- Valid hierarchy

Transaction validation requires:

- Correct entity
- Active project
- Customer compatibility
- Currency compatibility
- Requirement rules
- Project not closed/cancelled

---

## 48. Permissions

Suggested permissions:

- View/create/edit projects
- Activate/complete/close/reopen/archive
- Manage and approve budgets
- Enter/approve time
- Enter/approve expenses
- Create project billing
- Run/post/reverse revenue recognition
- View profitability
- View internal cost
- Export reports
- Override validation

---

## 49. Audit trail

Record:

- Project created
- Code/customer/manager changed
- Billing method changed
- Contract value changed
- Change order approved
- Budget created/approved
- Time entered/approved/billed
- Expense entered/approved/billed
- Invoice created
- Bill posted
- Revenue recognition posted/reversed
- Project completed/closed/reopened/archived
- Validation override used

---

## 50. Recommended files

```text
src/
  types/
    project.ts
    projectBudget.ts
    projectTime.ts
    projectBilling.ts
    projectRevenueRecognition.ts

  store/
    projectStore.ts
    projectBudgetStore.ts
    projectTimeStore.ts
    projectBillingStore.ts
    projectRevenueRecognitionStore.ts

  lib/
    projectHierarchy.ts
    projectValidation.ts
    projectResolution.ts
    projectBudget.ts
    projectProfitability.ts
    projectBilling.ts
    projectRevenueRecognition.ts
    projectRevenuePosting.ts
    projectWip.ts
    projectCashFlow.ts
    projectReporting.ts
    projectSnapshots.ts

  components/
    projects/
      ProjectList.tsx
      ProjectEditor.tsx
      ProjectDrawer.tsx
      ProjectPicker.tsx
      ProjectOverview.tsx
      ProjectFinancialSummary.tsx
      ProjectBudgetEditor.tsx
      ProjectTimeEntry.tsx
      ProjectExpenseEntry.tsx
      ProjectBillingWorkspace.tsx
      ProjectMilestones.tsx
      ProjectChangeOrders.tsx
      ProjectCommitments.tsx
      ProjectRevenueRecognition.tsx
      ProjectProfitabilityReport.tsx
      ProjectIncomeStatement.tsx
      ProjectLedger.tsx
      ProjectBudgetVsActual.tsx
      ProjectCashFlowReport.tsx
      ProjectCloseDialog.tsx

  pages/
    ProjectsPage.tsx
    ProjectDetailsPage.tsx
    ProjectReportsPage.tsx
    ProjectBillingPage.tsx
    ProjectTimeExpensesPage.tsx
```

---

## 51. Core functions

```ts
checkDuplicateProjectCode(...)
generateProjectCode(...)
buildProjectTree(...)
validateProjectHierarchy(...)
getProjectDescendants(...)
getProjectAncestors(...)
resolveDefaultProject(...)
calculateProjectBudgetTotals(...)
calculateProjectProfitability(...)
calculateProjectCashFlow(...)
calculateCostPlusBilling(...)
calculatePercentageOfCompletion(...)
buildProjectBillingDraft(...)
buildProjectRevenueRecognitionRun(...)
buildProjectRevenueRecognitionJournal(...)
postProjectRevenueRecognition(...)
reverseProjectRevenueRecognitionRun(...)
buildProjectIncomeStatement(...)
buildProjectLedger(...)
buildProjectBudgetVsActual(...)
validateProjectForClose(...)
createProjectSnapshot(...)
```

---

## 52. Persistence

Persist with Zustand and LocalStorage:

- Projects
- Hierarchy
- Budgets
- Time entries
- Expense entries
- Milestones
- Change orders
- Commitments
- Billing links
- Revenue-recognition runs
- Journal/reversal links
- Audit metadata

Do not persist derived profitability as authoritative accounting data.

---

## 53. Acceptance scenarios

### Fixed-price project

```text
Contract value: 1,000,000
Budget cost: 700,000
Billed: 400,000
Recognized revenue: 350,000
Actual cost: 250,000
Cash collected: 300,000
```

Expected:

```text
Gross profit: 100,000
Gross margin: 28.57%
```

### Time and materials

```text
100 approved hours × 100 = 10,000
Approved expenses = 2,000
Billing draft = 12,000 before tax
```

Expected:

- Invoice created through invoice module
- Sources marked billed
- Duplicate billing blocked

### Cost plus

```text
Eligible cost: 50,000
Markup: 15%
Billing: 57,500
```

### Percentage of completion

```text
Revised contract value: 1,200,000
Actual cost to date: 300,000
Estimated total cost: 800,000
Completion: 37.5%
Cumulative revenue: 450,000
Prior revenue: 320,000
Current-period revenue: 130,000
```

Only 130,000 is posted in the current period.

### Project cash flow

```text
Receipts allocated: 120,000
Payments allocated: 70,000
Net cash flow: 50,000
```

---

## 54. Tests

Add tests for:

1. Unique project code
2. Circular hierarchy blocked
3. Customer project requires customer
4. Closed project blocks posting
5. Invoice customer compatibility
6. Credit note inheritance
7. Bill project posting
8. Supplier credit inheritance
9. Receipt project cash allocation
10. Payment project cash allocation
11. Multi-project receipt allocation
12. Multi-project payment allocation
13. Budget versioning
14. Time entry validation
15. Duplicate time billing blocked
16. Duplicate expense billing blocked
17. Cost-plus billing
18. Fixed-price billing cap
19. Milestone billing
20. Change-order update
21. Original contract value preserved
22. Percentage-of-completion calculation
23. Current-period recognition only
24. Revenue cap
25. WIP posting
26. Unbilled revenue posting
27. Deferred revenue posting
28. Exact recognition reversal
29. Profitability calculation
30. Zero-revenue margin handling
31. Cash flow from receipts/payments only
32. Project Income Statement
33. Project Ledger
34. Budget vs actual
35. Commitments excluded from GL
36. Project and cost center separate
37. Multi-currency base values
38. Tax treatment
39. Closeout validation
40. Reopen permission
41. Historical snapshot
42. Archived project historical rendering
43. LocalStorage hydration
44. Empty state
45. Picker scrolling
46. Mobile layout
47. Route refresh

---

## 55. QA

Run:

- TypeScript typecheck
- Full unit tests
- Production build
- Project creation smoke test
- Hierarchy test
- Invoice/bill integration tests
- Receipt/payment cash-flow test
- Budget test
- Time-and-materials billing test
- Cost-plus billing test
- Milestone billing test
- Percentage-of-completion test
- WIP/unbilled/deferred test
- Revenue-recognition reversal test
- Profitability report test
- Project Income Statement test
- Project Ledger test
- Budget vs actual test
- Closeout test
- LocalStorage test
- Mobile and picker tests
- Route refresh test

Report:

- Files created
- Files modified
- Project types and billing methods
- Accounting integration
- Budget logic
- Time/expense logic
- Billing logic
- Revenue-recognition logic
- WIP/unbilled/deferred logic
- Profitability and cash-flow results
- Acceptance-scenario results
- Tests
- Typecheck
- Production build
- Deferred items

---

## Core accounting rules

Project is an accounting and management dimension. It does not replace the account or cost center.

```text
Account: Professional fees revenue
Project: Dubai Hotel Conversion
Cost center: Consulting
```

Keep these concepts separate:

```text
Billed revenue ≠ Recognized revenue ≠ Cash collected
Actual cost ≠ Committed cost ≠ Cash paid
```

Historical posted transactions must not change when a project is renamed, completed, closed, moved, or archived.
