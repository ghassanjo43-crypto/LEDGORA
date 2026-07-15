# IFRS-Aligned Chart of Accounts Builder

A production-quality React + TypeScript application for creating, managing,
validating, and exporting a configurable, industry-adaptable **Chart of
Accounts** that maps to IFRS-style financial-statement presentation categories.

> **Important accounting note:** IFRS does **not** prescribe a single universal
> mandatory chart of accounts. The codes generated here are **internal
> management / accounting codes aligned with IFRS presentation principles
> (IAS 1 / IFRS 18)** — they are *not* official IFRS codes. The default chart is
> **seed data**: after loading it, you can fully customise every account for your
> own company, industry and reporting structure.

## Features

- **Default chart of accounts** — 120+ realistic, hierarchical accounts across
  all IFRS presentation categories, generated as editable seed data.
- **Full editing** — add, edit, delete, duplicate, activate/deactivate, reorder
  (drag or move up/down), re-parent, and inline-edit (double-click a row).
- **Hierarchical tree** — expand/collapse, header vs. posting accounts, badges
  for type, statement, balance and status.
- **IFRS mapping view** — accounts grouped by financial statement
  (SoFP, P&L, OCI, SoCE, Cash Flow, Control) and IFRS category.
- **Validation engine** — unique codes, parent existence, posting/header rules,
  code-range vs. type, normal-balance convention, cash-flow requirements,
  IFRS 18 P&L category checks.
- **Import / Export** — CSV and JSON, with pre-save parsing + validation preview.
- **Search & filters** — by code/name/category and by type, statement, status,
  and posting/header — updates live as you edit.
- **IFRS 18 readiness** — optional presentation mode that adds an
  operating / investing / financing / income-taxes / discontinued-operations
  classification to profit-or-loss accounts.
- **Settings** — company name, industry, base currency, fiscal year start,
  IAS 1 vs. IFRS 18 presentation mode.
- **Dark / light mode**, responsive design, and **LocalStorage persistence**
  (your edits survive a refresh).

## Tech stack

| Concern           | Choice                                   |
| ----------------- | ---------------------------------------- |
| Framework         | React 18 + TypeScript (strict)           |
| Build tool        | Vite                                     |
| Styling           | Tailwind CSS (class-based dark mode)     |
| State             | Zustand (+ `persist` to LocalStorage)    |
| Forms             | React Hook Form                          |
| Validation        | Zod (forms + imported data)              |

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default `http://localhost:5173`).

Other scripts:

```bash
npm run build      # type-check + production build
npm run preview    # preview the production build
npm run typecheck  # strict TypeScript check only
```

## Project structure

```
src/
├─ components/
│  ├─ ui/            Reusable primitives: Button, Input, Select, Card, Badge,
│  │                 Alert, Drawer, Toggle, ConfirmDialog, Toast, icons
│  ├─ layout/        AppLayout, Sidebar
│  ├─ shared/        AccountBadges, SearchAndFilterBar
│  ├─ dashboard/     DashboardCards
│  ├─ tree/          AccountTree, AccountNode (inline edit + drag reorder)
│  ├─ account/       AccountFormDrawer (create/edit form)
│  ├─ mapping/       IFRSMappingTable
│  ├─ validation/    ValidationPanel
│  ├─ importexport/  ImportExportPanel
│  └─ settings/      SettingsPanel
├─ data/
│  ├─ ifrsOptions.ts   Type metadata, code ranges, select options
│  └─ seedAccounts.ts  Default IFRS-aligned chart (seed data)
├─ hooks/            useTheme
├─ lib/              Business logic — no UI:
│  ├─ accountTree.ts   Tree building, descendants, cycle detection, levels
│  ├─ selectors.ts     Stats, filtering, ancestor expansion
│  ├─ validation.ts    Zod schemas + cross-account rule engine
│  ├─ importExport.ts  CSV/JSON serialise & parse
│  └─ utils.ts         cn, id, dates, download
├─ pages/            One component per view
├─ store/            useStore.ts (Zustand, all CRUD + persistence)
└─ types/            Account, AccountType, IFRSStatement, ValidationIssue, …
```

## Data model

Each `Account` carries: `id`, `code`, `name`, `type`, `parentId`, `level`,
`normalBalance`, `ifrsStatement`, `ifrsCategory`, `ifrsSubcategory`,
`cashFlowCategory`, optional `profitOrLossCategory` (IFRS 18),
`isPostingAccount`, `isActive`, `description`, `industryTag`, `sortOrder`,
`createdAt`, `updatedAt`.

### Code ranges

| Range       | Category                                                   |
| ----------- | ---------------------------------------------------------- |
| 1000–1999   | Assets                                                     |
| 2000–2999   | Liabilities                                                |
| 3000–3999   | Equity                                                     |
| 4000–4999   | Revenue / Income                                           |
| 5000–5999   | Cost of Sales / Direct Costs                               |
| 6000–6999   | Operating Expenses                                         |
| 7000–7999   | Other Income / Expenses, Investment Income, Finance        |
| 8000–8999   | Taxation, Discontinued Operations, OCI                     |
| 9000–9999   | Control, Suspense, Clearing & System accounts              |

## Extending later

Business logic is deliberately separated from UI (`src/lib`, `src/store`) so the
same account model can drive future modules: journal entries, trial balance,
statement of profit or loss, statement of financial position, statement of cash
flows, and other financial reports.
```
