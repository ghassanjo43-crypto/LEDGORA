# Ledgora Editions & Module Entitlements — Phase 1

## Goal

Implement one Ledgora codebase with one accounting engine and multiple commercial editions. Customers must see only the modules included in their edition or purchased as add-ons.

Do not create separate Core, Projects, or Construction applications.

---

## 1. Editions

```ts
export type LedgoraEdition =
  | "core"
  | "projects"
  | "construction"
  | "enterprise"
```

### Core

- Core accounting
- Sales and purchases
- Customers and suppliers
- Invoices, credit notes, receipts
- Bills, supplier credits, payments
- Customer and supplier statements
- Basic tax and currencies
- Standard financial statements

### Projects

Everything in Core, plus:

- Cost centers
- Projects
- Project budgets
- Time and expenses
- Project billing
- Project profitability
- Project cash flow
- Project reports

### Construction

Everything in Projects, plus:

- Construction project profiles
- WBS
- Cost codes
- BOQ
- Progress billing
- Retention
- Subcontracts
- Variations
- Commitments
- Materials
- Labor
- Equipment
- WIP
- Revenue recognition
- Forecast-at-completion

### Enterprise

All stable modules plus future multi-entity, consolidation, advanced approvals, permissions, API, and custom reporting.

---

## 2. Module Registry

Create `src/types/entitlements.ts`:

```ts
export type LedgoraModule =
  | "core_accounting"
  | "sales"
  | "purchases"
  | "customer_statements"
  | "supplier_statements"
  | "tax_basic"
  | "tax_advanced"
  | "currency_basic"
  | "currency_advanced"
  | "cost_centers"
  | "cost_center_budgets"
  | "cost_allocations"
  | "projects"
  | "project_budgets"
  | "project_time_expenses"
  | "project_billing"
  | "project_profitability"
  | "project_cash_flow"
  | "construction_projects"
  | "construction_wbs"
  | "construction_cost_codes"
  | "construction_boq"
  | "construction_progress_billing"
  | "construction_retention"
  | "construction_subcontracts"
  | "construction_variations"
  | "construction_commitments"
  | "construction_materials"
  | "construction_labor"
  | "construction_equipment"
  | "construction_wip"
  | "construction_revenue_recognition"
  | "construction_forecasting"
  | "advanced_reporting"
  | "multi_entity"
  | "approvals"
  | "audit_admin"
```

Create:

```ts
export type ModuleDefinition = {
  id: LedgoraModule
  name: string
  description: string
  category:
    | "core"
    | "sales"
    | "purchases"
    | "projects"
    | "construction"
    | "reporting"
    | "administration"
  dependencies: LedgoraModule[]
  defaultForEditions: LedgoraEdition[]
  isVisibleInAdmin: boolean
  isExperimental?: boolean
}
```

Add a single registry in `src/config/modules.ts`.

---

## 3. Edition Presets

Create `src/config/editions.ts`.

```ts
export const EDITION_MODULES: Record<
  LedgoraEdition,
  LedgoraModule[]
>
```

Core includes only accounting, sales, purchases, statements, basic tax, and basic currencies.

Projects includes Core plus cost centers and project features.

Construction includes Projects plus construction features.

Enterprise includes all stable modules.

Avoid circular runtime constants. Use a safe builder function if needed.

---

## 4. Subscription Model

Create `src/types/subscription.ts`.

```ts
export type SubscriptionStatus =
  | "trial"
  | "active"
  | "past-due"
  | "suspended"
  | "cancelled"
  | "expired"

export type OrganizationSubscription = {
  id: string
  organizationId: string

  edition: LedgoraEdition
  status: SubscriptionStatus

  enabledModules: LedgoraModule[]
  disabledModules: LedgoraModule[]

  userLimit: number
  entityLimit: number

  startsAt: string
  expiresAt?: string

  activationMethod:
    | "manual"
    | "bank-remittance"
    | "trial"
    | "admin"

  bankRemittanceReference?: string
  adminNotes?: string

  createdAt: string
  updatedAt: string
  activatedAt?: string
  suspendedAt?: string
}
```

No online card billing is required in this phase. Support manual activation after bank-remittance confirmation.

---

## 5. Effective Entitlements

Create:

```ts
resolveEffectiveModules(subscription)
```

Rules:

1. Begin with the edition preset.
2. Add explicit add-ons.
3. Remove explicitly disabled modules.
4. Expand required dependencies.
5. Reject invalid dependency combinations.
6. Return a stable ordered list.

Create:

```ts
export type EffectiveEntitlements = {
  edition: LedgoraEdition
  status: SubscriptionStatus
  moduleIds: LedgoraModule[]
  userLimit: number
  entityLimit: number
  isTrial: boolean
  isSuspended: boolean
  isExpired: boolean
}
```

Do not return a fresh `Set` from Zustand selectors on every render.

---

## 6. Dependency Examples

```text
project_budgets requires projects
project_billing requires projects and sales
project_cash_flow requires projects, sales, and purchases

construction_boq requires construction_projects
construction_progress_billing requires construction_boq and sales
construction_retention requires construction_projects
construction_subcontracts requires construction_projects and purchases
construction_wip requires construction_projects and core_accounting
construction_revenue_recognition requires construction_projects and construction_wip
```

Create:

```ts
validateModuleDependencies(...)
expandModuleDependencies(...)
getMissingDependencies(...)
```

---

## 7. Entitlement Store

Create `src/store/entitlementStore.ts`.

```ts
type EntitlementState = {
  subscription: OrganizationSubscription
  effectiveModuleIds: LedgoraModule[]

  setEdition: (edition: LedgoraEdition) => void
  setSubscriptionStatus: (status: SubscriptionStatus) => void

  enableModule: (module: LedgoraModule) => void
  disableModule: (module: LedgoraModule) => void

  activateSubscription: (...) => void
  suspendSubscription: (...) => void
  renewSubscription: (...) => void

  hasModule: (module: LedgoraModule) => boolean
}
```

Persist with Zustand and LocalStorage using a versioned migration.

---

## 8. Existing Data Migration

Current development/demo organizations already use many modules.

Migration rule:

```text
Existing local organization with no subscription
→ create Enterprise development subscription
```

This avoids hiding existing modules after the change.

New organizations must explicitly select an edition.

Do not delete or rewrite existing records.

---

## 9. Shared Access Helpers

Create:

```ts
hasModule(...)
hasAllModules(...)
hasAnyModule(...)
canAccessFeature(...)
```

Hooks:

```ts
useHasModule(...)
useHasAllModules(...)
useHasAnyModule(...)
useCurrentEdition(...)
useSubscriptionStatus(...)
```

Entitlement and user permission are separate:

```text
Organization owns module
AND
User has permission
```

Both must be true.

---

## 10. FeatureGate

Create:

```tsx
<FeatureGate module="projects" fallback={null}>
  <ProjectsPage />
</FeatureGate>
```

Support:

```ts
type FeatureGateProps = {
  module?: LedgoraModule
  allModules?: LedgoraModule[]
  anyModules?: LedgoraModule[]
  fallback?: React.ReactNode
  children: React.ReactNode
}
```

Default unavailable UI behavior is hidden, not disabled.

---

## 11. Navigation Filtering

Extend navigation items:

```ts
requiredModule?: LedgoraModule
requiredAnyModules?: LedgoraModule[]
requiredAllModules?: LedgoraModule[]
```

Create:

```ts
filterNavigationByEntitlements(...)
```

Requirements:

- Hide unavailable items
- Hide empty groups
- Preserve order
- Remove orphan separators
- Do not expose construction terms to Core customers

Expected:

```text
Core:
No Projects, Cost Centers, or Construction groups

Projects:
Projects and Cost Centers visible
Construction hidden

Construction:
Projects, Cost Centers, and Construction visible
```

---

## 12. Route Guards

Typing a protected URL must not bypass entitlements.

Create:

```tsx
<ModuleRoute
  module="construction_boq"
  element={<BoqPage />}
/>
```

Blocked route behavior:

- Do not render protected content
- Redirect safely or show `/module-unavailable`
- Do not crash

Suggested message:

```text
This feature is not included in your current Ledgora edition.
Contact your administrator to enable it.
```

---

## 13. Dashboard Filtering

Dashboard widgets declare required modules.

```ts
type DashboardWidgetDefinition = {
  id: string
  title: string
  requiredModule?: LedgoraModule
  component: React.ComponentType
}
```

Core dashboard:

- Cash
- Receivables
- Payables
- Revenue
- Expenses
- Profit
- Tax
- Recent activity

Projects adds:

- Project profitability
- Budget variance
- Project cash flow
- Project balances

Construction adds:

- Contract value
- Certified work
- Retention
- Commitments
- WIP
- Forecast final cost
- Progress claims
- Variations

Do not show empty unavailable widgets.

---

## 14. Form Field Filtering

Use the same invoice, bill, journal, and credit-note editors across editions.

Examples:

```text
Core invoice line:
Account, description, quantity, price, tax

Projects invoice line:
Core fields + project + cost center

Construction invoice line:
Projects fields + WBS + cost code + BOQ item where applicable
```

Do not fork entire editors per edition.

Only validate dimensions belonging to enabled modules.

---

## 15. Historical Data After Downgrade

When a module is disabled:

- Hide navigation
- Block new module records
- Preserve historical records
- Preserve journal metadata
- Preserve document snapshots
- Keep GL balances unchanged
- Do not delete data

A later upgrade must restore access to preserved records.

---

## 16. Subscription Settings Page

Create:

```text
/settings/subscription
```

Show:

- Current edition
- Status
- Dates
- User limit
- Entity limit
- Enabled add-ons
- Disabled modules
- Bank-remittance reference
- Admin notes

Development/admin actions:

- Change edition
- Enable/disable add-on
- Activate
- Suspend
- Renew
- Extend expiry
- Update limits

These may move to a backend admin service later.

---

## 17. Development Edition Switcher

Create a development-only selector:

```text
Core
Projects
Construction
Enterprise
```

Requirements:

- Hidden in production unless authorized
- Updates UI immediately
- Route guards update immediately
- No white screen
- No unstable Zustand selectors

---

## 18. Subscription Status Rules

MVP behavior:

```text
Trial or Active:
Normal access

Suspended or Expired:
Preserve data
Show warning
Block new posting
Allow controlled reporting/export
```

Create:

```ts
assertSubscriptionAllowsPosting(...)
```

Do not delete data when subscription status changes.

---

## 19. Limits

Create:

```ts
canCreateUser(...)
canCreateEntity(...)
```

Show clear validation when limits are exceeded.

Example:

```text
Your current Ledgora subscription supports up to 2 entities.
```

---

## 20. Onboarding

New organization onboarding asks:

```text
Which Ledgora edition fits your business?
```

Cards:

- Core — complete bookkeeping
- Projects — project profitability and cost control
- Construction — contract, BOQ, retention, WIP, and construction control
- Enterprise — advanced multi-entity and customization

After selection:

- Create subscription
- Seed relevant data only
- Build relevant dashboard
- Hide irrelevant modules

---

## 21. Edition-Specific Seed Data

Create:

```ts
seedOrganizationForEdition(...)
```

Core seeds only accounting, customers, suppliers, and standard transactions.

Projects additionally seeds cost centers, projects, and project budgets.

Construction additionally seeds WBS, cost codes, BOQ, retention, and subcontract examples.

Do not seed construction data into Core organizations.

---

## 22. Reports, Search, and Commands

Reports and command-palette actions must declare required modules.

Examples:

```text
Income Statement → core_accounting
Cost Center Income Statement → cost_centers
Project Profitability → project_profitability
BOQ Progress → construction_boq
Retention Report → construction_retention
WIP Report → construction_wip
```

Global search must not expose unavailable pages or commands.

---

## 23. Audit Trail

Record:

- Edition selected
- Subscription activated
- Subscription renewed
- Subscription suspended
- Module enabled/disabled
- User/entity limit changed
- Bank-remittance reference recorded
- Admin override
- Development edition switched

---

## 24. Recommended Files

```text
src/
  types/
    entitlements.ts
    subscription.ts

  config/
    modules.ts
    editions.ts
    editionCommercialInfo.ts

  store/
    entitlementStore.ts

  lib/
    entitlementResolution.ts
    entitlementValidation.ts
    entitlementMigration.ts
    subscriptionPostingGuard.ts
    editionSeeding.ts

  components/
    entitlements/
      FeatureGate.tsx
      ModuleRoute.tsx
      ModuleUnavailablePage.tsx
      EditionBadge.tsx
      SubscriptionStatusBanner.tsx
      DevelopmentEditionSwitcher.tsx

    settings/
      SubscriptionSettingsPage.tsx
      EditionSelector.tsx
      ModuleEntitlementTable.tsx
      BankRemittanceActivationPanel.tsx

  pages/
    SubscriptionPage.tsx
    ModuleUnavailablePage.tsx
```

Modify:

- Navigation registry
- App routing
- Dashboard registry
- Global search/commands
- Forms
- Posting workflows
- Onboarding
- Seed initialization

---

## 25. Acceptance Scenarios

### Core

Visible:

- Accounting
- Sales
- Purchases
- Statements
- Basic tax/currencies

Hidden:

- Cost Centers
- Projects
- Construction

Project/cost-center/construction fields do not appear.

### Projects

Core plus Projects and Cost Centers.

Construction remains hidden.

### Construction

Core plus Projects, Cost Centers, and Construction.

WBS, cost code, BOQ, and retention fields appear only where relevant.

### Add-on

Core organization enables Cost Centers:

- Cost Centers appears
- Cost-center fields and reports appear
- Projects remain hidden

### Downgrade

Projects → Core:

- Project UI hidden
- No new project postings
- Historical project metadata preserved
- GL unchanged

### Suspended

- Sign-in remains possible
- Warning shown
- New posting blocked
- Existing data preserved
- Admin can reactivate after bank-remittance confirmation

---

## 26. Tests

Add tests for:

1. Correct Core preset
2. Projects includes Core
3. Construction includes Projects
4. Enterprise includes stable modules
5. Add-ons
6. Explicit disables
7. Dependency expansion
8. Invalid dependencies
9. Navigation filtering
10. Empty groups removed
11. Route guards
12. Dashboard filtering
13. Report filtering
14. Command filtering
15. Form-field filtering
16. Core posting skips project validation
17. Historical metadata preservation
18. Existing-data migration
19. Add-on without edition upgrade
20. Downgrade without deletion
21. Suspended posting block
22. Active posting allowed
23. Trial expiry
24. Entity limit
25. User limit
26. Development switcher
27. LocalStorage hydration
28. Store migration
29. Stable selectors
30. Protected-route refresh
31. Edition-specific seed
32. Bank-remittance activation
33. Audit events

---

## 27. QA

Run:

- `tsc --noEmit`
- Full test suite
- Production build
- Core smoke test
- Projects smoke test
- Construction smoke test
- Enterprise smoke test
- Add-on test
- Downgrade test
- Suspended posting test
- Route-guard test
- Navigation test
- Dashboard test
- Form filtering test
- Search/command test
- LocalStorage migration test
- Selector-safety scan
- Clean dev-server restart

Report:

- Files created and modified
- Edition presets
- Module registry
- Dependency handling
- Navigation and route behavior
- Dashboard and form behavior
- Subscription behavior
- Migration behavior
- Tests
- Typecheck
- Build
- Deferred work

---

## 28. Phase Boundary

This phase creates the edition and entitlement foundation only.

Do not build every Construction feature in the same change.

After this is green:

### Construction Phase 1

- Construction project profile
- WBS
- Cost codes
- BOQ
- Basic retention
- Construction dashboard

### Construction Phase 2

- Progress claims
- Interim certificates
- Subcontracts
- Variations
- Commitments

### Construction Phase 3

- Materials
- Labor
- Equipment
- WIP
- Revenue recognition
- Forecast-at-completion
- Advanced reports

---

## Final Principle

```text
One Ledgora codebase
+ one accounting engine
+ centralized module entitlements
+ edition-specific navigation
+ edition-specific workflows
+ preserved historical data
```

A Core customer experiences focused bookkeeping.

A Projects customer experiences project accounting.

A Construction customer experiences construction financial control.

No customer sees or pays for modules they do not need.
