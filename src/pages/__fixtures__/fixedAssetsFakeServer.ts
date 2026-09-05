/**
 * An in-memory fixed-asset register, standing where `fetch` does.
 *
 * ══ Why a fake at the network boundary rather than a mocked module ═══════════
 *
 * The point of the F1 cutover tests is that a durable subscriber's clicks reach
 * the server. Mocking `fixedAssetsApi` would leave the URL, the method, the
 * body shape and the error mapping untested — exactly the layer that decides
 * whether a register is durable or is quietly going into browser storage. So
 * the real client runs, and this answers it.
 *
 * ══ It enforces the real rules, in the real words ════════════════════════════
 *
 * Case-insensitive code uniqueness, held asset numbering, optimistic versions,
 * the contra-asset rule for accumulated depreciation, refusal of every
 * unsupported method by name, and refusal to archive a category assets still
 * need. The sentences are the server's own, so a screen that garbled or
 * replaced one fails the test that reads it.
 *
 * There is NO cost endpoint, no depreciation route and no schedule here,
 * because there is none there.
 */

type Json = Record<string, unknown>;

interface FakeCategory {
  id: string;
  code: string;
  name: string;
  description: string;
  defaultMethod: string;
  defaultUsefulLifeMonths: number | null;
  defaultResidualPercent: string;
  depreciationConvention: string;
  assetCostAccountId: string | null;
  accumulatedDepreciationAccountId: string | null;
  depreciationExpenseAccountId: string | null;
  status: string;
  version: number;
}

interface FakeAsset {
  id: string;
  assetCode: string;
  name: string;
  description: string;
  categoryId: string;
  acquisitionDate: string;
  depreciationStartDate: string | null;
  depreciationMethod: string;
  usefulLifeMonths: number | null;
  residualValue: string;
  quantity: number;
  location: string;
  custodian: string;
  branch: string;
  department: string;
  supplierPartyId: string | null;
  purchaseReference: string;
  notes: string;
  status: string;
  version: number;
}

interface FakeAuditEvent {
  id: string;
  subjectType: 'category' | 'asset';
  subjectId: string;
  action: string;
  previousVersion: number | null;
  resultingVersion: number | null;
  reason: string;
  detail: Json;
  actorName: string;
  occurredAt: string;
}

const NOW = '2026-01-01T00:00:00.000Z';

/**
 * The chart the category pickers are narrowed against.
 *
 * `normalBalance` is what separates the cost account from accumulated
 * depreciation: both are assets, and the credit one is the contra-asset.
 */
export const FAKE_ACCOUNTS = [
  {
    id: 'acc-cost', code: '1112', name: 'Plant and machinery',
    type: 'ASSET', normalBalance: 'DEBIT',
  },
  {
    id: 'acc-accum', code: '1119', name: 'Accumulated depreciation — PP&E',
    type: 'ASSET', normalBalance: 'CREDIT',
  },
  {
    id: 'acc-expense', code: '6600', name: 'Depreciation expense',
    type: 'OPERATING_EXPENSE', normalBalance: 'DEBIT',
  },
];

export const server = {
  categories: [] as FakeCategory[],
  assets: [] as FakeAsset[],
  audit: [] as FakeAuditEvent[],
  suppliers: [] as Array<{ id: string; legalName: string; partyCode: string }>,
  /** The held asset sequence. Never a MAX over the register. */
  nextSequence: 1,
  /** Every request this fake answered, so a test can assert what was called. */
  calls: [] as Array<{ method: string; path: string }>,
  nextId: 1,
};

export function resetServer(): void {
  server.categories = [];
  server.assets = [];
  server.audit = [];
  server.suppliers = [];
  server.nextSequence = 1;
  server.calls = [];
  server.nextId = 1;
}

const id = (prefix: string): string => `${prefix}-${server.nextId++}`;

const ok = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (status: number, code: string, message: string, fieldErrors?: Json): Response =>
  new Response(
    JSON.stringify({ error: { code, message, details: fieldErrors ? { fieldErrors } : undefined } }),
    { status, headers: { 'content-type': 'application/json' } },
  );

const sameCode = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const STALE =
  'This record was changed by another user while you were editing it. Reload and try again so you '
  + 'do not overwrite their change.';

/** The server's own refusals, verbatim. A screen that rewords one fails here. */
export const REFUSED_METHODS: Record<string, string> = {
  reducing_balance:
    'Reducing balance is not available yet. Its annual rate exists only on an individual asset — '
    + 'an asset category has no rate to state — so a category typed "reducing balance" could not '
    + 'express the policy it claims. It arrives with the depreciation engine that needs it.',
  units_of_production:
    'Units of production is not available yet. It charges depreciation against units consumed in a '
    + 'period, and this product has no source of usage — no meter, no output record, nothing that '
    + 'could say how much an asset was used. A schedule with no usage behind it would be invented.',
};

const CAPABILITIES = {
  registerRecords: true,
  categories: true,
  accountMappings: true,
  archiveAndReactivate: true,
  auditHistory: true,
  acquisitionCost: false,
  capitalization: false,
  depreciationSchedules: false,
  depreciationPosting: false,
  depreciationPreview: false,
  impairment: false,
  revaluation: false,
  disposal: false,
  transfers: false,
  billAcquisition: false,
  componentAccounting: false,
  taxBooks: false,
  multipleBooks: false,
  attachments: false,
  foreignCurrency: false,
  usefulLifeUnit: 'months',
  supportedMethods: ['straight_line', 'none'],
  supportedConventions: ['full_month'],
  deferred: {
    capitalization:
      'Capitalisation is not available yet. Recording an asset\'s cost creates a journal.',
    depreciation:
      'Depreciation is not available yet. No schedule is generated and no charge is posted.',
    disposal: 'Disposal, sale, write-off and retirement are not available yet.',
    impairment: 'Impairment and impairment reversal are not available yet.',
    revaluation: 'Revaluation is not available yet.',
    billAcquisition: 'A supplier bill cannot create or capitalise a fixed asset yet.',
  },
};

function audit(
  subjectType: 'category' | 'asset',
  subjectId: string,
  action: string,
  previousVersion: number | null,
  resultingVersion: number,
  detail: Json = {},
  reason = '',
): void {
  server.audit.unshift({
    id: id('aud'),
    subjectType,
    subjectId,
    action,
    previousVersion,
    resultingVersion,
    reason,
    detail,
    /* The server's, from the session. A client-supplied actor never reaches it. */
    actorName: 'Test Person',
    occurredAt: NOW,
  });
}

function categoryView(c: FakeCategory): Json {
  const account = (accountId: string | null): string => {
    const found = FAKE_ACCOUNTS.find((a) => a.id === accountId);
    return found ? `${found.code} — ${found.name}` : '';
  };
  return {
    ...c,
    assetCostAccountLabel: account(c.assetCostAccountId),
    accumulatedDepreciationAccountLabel: account(c.accumulatedDepreciationAccountId),
    depreciationExpenseAccountLabel: account(c.depreciationExpenseAccountId),
    mappingComplete: Boolean(
      c.assetCostAccountId && c.accumulatedDepreciationAccountId && c.depreciationExpenseAccountId,
    ),
    activeAssetCount: server.assets.filter(
      (a) => a.categoryId === c.id && a.status !== 'archived',
    ).length,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function assetView(a: FakeAsset): Json {
  const category = server.categories.find((c) => c.id === a.categoryId);
  const supplier = server.suppliers.find((s) => s.id === a.supplierPartyId);
  return {
    ...a,
    categoryCode: category?.code ?? '',
    categoryName: category?.name ?? '',
    supplierName: supplier?.legalName ?? '',
    usefulLifeUnit: 'months',
    depreciationConvention: 'full_month',
    /* Zero throughout F1 — and returned, so a screen states it. */
    accountingActivityCount: 0,
    policyEditable: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The three account roles, checked exactly as the server checks them. */
function assertAccounts(body: Json): Response | null {
  const roles: Array<[string, string, 'ASSET' | 'OPERATING_EXPENSE', 'DEBIT' | 'CREDIT', string]> = [
    ['assetCostAccountId', 'fixed asset cost', 'ASSET', 'DEBIT', 'debit'],
    [
      'accumulatedDepreciationAccountId', 'accumulated depreciation', 'ASSET', 'CREDIT',
      'credit',
    ],
    ['depreciationExpenseAccountId', 'depreciation expense', 'OPERATING_EXPENSE', 'DEBIT', 'debit'],
  ];
  for (const [field, label, type, balance, word] of roles) {
    const value = body[field] as string | null | undefined;
    if (!value) continue;
    const account = FAKE_ACCOUNTS.find((a) => a.id === value);
    if (!account) {
      return fail(400, 'validation_error',
        `The ${label} account does not exist in these books.`,
        { [field]: 'Choose an account from this company’s chart of accounts.' });
    }
    if (account.type !== type || account.normalBalance !== balance) {
      const reason = label === 'accumulated depreciation'
        ? 'Accumulated depreciation is a CONTRA-ASSET: an asset-type account whose normal balance '
          + 'is a credit, so the balance sheet can show cost less depreciation.'
        : `The ${label} account must have a ${word} normal balance.`;
      return fail(400, 'validation_error',
        `${account.code} (${account.name}) cannot be the ${label} account. ${reason}`,
        { [field]: `Choose an account whose normal balance is a ${word}.` });
    }
  }
  return null;
}

function writeCategory(body: Json, existing?: FakeCategory): FakeCategory | Response {
  const code = String(body.code ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (!code) return fail(400, 'validation_error', 'Check the category details and try again.', { code: 'A category code is required.' });
  if (!name) return fail(400, 'validation_error', 'Check the category details and try again.', { name: 'A category name is required.' });

  const method = String(body.defaultMethod ?? 'straight_line');
  if (method !== 'straight_line' && method !== 'none') {
    return fail(400, 'validation_error',
      REFUSED_METHODS[method]
      ?? `"${method}" is not a depreciation method this product implements.`,
      { defaultMethod: 'Choose straight line, or none.' });
  }

  if (server.categories.some((c) => sameCode(c.code, code) && c.id !== existing?.id)) {
    return fail(409, 'conflict',
      'That asset category code is already used in these books. Codes are compared without regard '
      + 'to case, so "MACH" and "mach" are the same code.');
  }

  const accountsRefused = assertAccounts(body);
  if (accountsRefused) return accountsRefused;

  return {
    id: existing?.id ?? id('cat'),
    code,
    name,
    description: String(body.description ?? ''),
    defaultMethod: method,
    defaultUsefulLifeMonths: method === 'none'
      ? null
      : Number(body.defaultUsefulLifeMonths ?? 60),
    defaultResidualPercent: String(body.defaultResidualPercent ?? '0'),
    depreciationConvention: 'full_month',
    assetCostAccountId: (body.assetCostAccountId as string) ?? null,
    accumulatedDepreciationAccountId: (body.accumulatedDepreciationAccountId as string) ?? null,
    depreciationExpenseAccountId: (body.depreciationExpenseAccountId as string) ?? null,
    status: existing?.status ?? 'active',
    version: existing ? existing.version + 1 : 1,
  };
}

function writeAsset(body: Json, existing?: FakeAsset): FakeAsset | Response {
  const name = String(body.name ?? '').trim();
  if (!name) {
    return fail(400, 'validation_error', 'Check the asset details and try again.',
      { name: 'An asset name is required.' });
  }

  const category = server.categories.find((c) => c.id === body.categoryId);
  if (!category) {
    return fail(400, 'validation_error', 'That asset category does not exist in these books.',
      { categoryId: 'Choose a category from this company.' });
  }
  if (!existing && category.status !== 'active') {
    return fail(400, 'validation_error',
      `Category ${category.code} is archived and cannot take new assets.`,
      { categoryId: 'Choose an active category.' });
  }

  const method = String(body.depreciationMethod ?? category.defaultMethod);
  if (method !== 'straight_line' && method !== 'none') {
    return fail(400, 'validation_error',
      REFUSED_METHODS[method] ?? `"${method}" is not a depreciation method this product implements.`,
      { depreciationMethod: 'Choose straight line, or none.' });
  }

  const supplied = String(body.assetCode ?? '').trim();
  if (supplied && server.assets.some(
    (a) => sameCode(a.assetCode, supplied) && a.id !== existing?.id,
  )) {
    return fail(409, 'conflict',
      'That asset code is already used in these books. Codes are compared without regard to case, '
      + 'so "AST-0001" and "ast-0001" are the same code.');
  }

  /* The sequence is HELD: an archived asset never gives its code back. */
  const assetCode = existing?.assetCode
    ?? supplied
    ?? '';
  const allocated = assetCode || `AST-${String(server.nextSequence).padStart(4, '0')}`;
  if (!existing && !supplied) server.nextSequence += 1;

  return {
    id: existing?.id ?? id('ast'),
    assetCode: allocated,
    name,
    description: String(body.description ?? ''),
    categoryId: category.id,
    acquisitionDate: String(body.acquisitionDate ?? '2026-01-01'),
    depreciationStartDate: (body.depreciationStartDate as string) ?? null,
    depreciationMethod: method,
    usefulLifeMonths: method === 'none'
      ? null
      : Number(body.usefulLifeMonths ?? category.defaultUsefulLifeMonths ?? 60),
    residualValue: String(body.residualValue ?? '0'),
    quantity: Number(body.quantity ?? 1),
    location: String(body.location ?? ''),
    custodian: String(body.custodian ?? ''),
    branch: String(body.branch ?? ''),
    department: String(body.department ?? ''),
    supplierPartyId: (body.supplierPartyId as string) ?? null,
    purchaseReference: String(body.purchaseReference ?? ''),
    notes: String(body.notes ?? ''),
    status: existing?.status ?? 'draft',
    version: existing ? existing.version + 1 : 1,
  };
}

function registerReport(): Json {
  return {
    basis: 'register-master-data',
    reconcilesToGeneralLedger: false,
    note:
      'These are REGISTER figures — counts of records somebody has entered. They are not '
      + 'general-ledger balances and do not reconcile to one.',
    byCategory: server.categories.map((c) => {
      const mine = server.assets.filter((a) => a.categoryId === c.id);
      return {
        categoryId: c.id,
        categoryCode: c.code,
        categoryName: c.name,
        categoryStatus: c.status,
        draftAssets: mine.filter((a) => a.status === 'draft').length,
        archivedAssets: mine.filter((a) => a.status === 'archived').length,
        totalAssets: mine.length,
        totalUnits: mine.reduce((sum, a) => sum + a.quantity, 0),
        mappingComplete: Boolean(
          c.assetCostAccountId && c.accumulatedDepreciationAccountId
          && c.depreciationExpenseAccountId,
        ),
      };
    }),
    totals: {
      categories: server.categories.length,
      activeCategories: server.categories.filter((c) => c.status === 'active').length,
      archivedCategories: server.categories.filter((c) => c.status === 'archived').length,
      assets: server.assets.length,
      draftAssets: server.assets.filter((a) => a.status === 'draft').length,
      archivedAssets: server.assets.filter((a) => a.status === 'archived').length,
      totalUnits: server.assets.reduce((sum, a) => sum + a.quantity, 0),
    },
    configurationIssues: server.categories
      .filter((c) => c.defaultMethod !== 'none' && !(
        c.assetCostAccountId && c.accumulatedDepreciationAccountId
        && c.depreciationExpenseAccountId
      ))
      .map((c) => ({
        subjectType: 'category',
        subjectId: c.id,
        code: c.code,
        name: c.name,
        issue: 'missing-account-mapping',
        detail: `Category ${c.code} has incomplete account mappings.`,
      })),
  };
}

export function install(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://server.test');
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Json = init?.body ? JSON.parse(String(init.body)) : {};
    server.calls.push({ method, path });

    /* ── Suppliers, so the asset form has a picker ──────────────────────── */
    if (path === '/api/suppliers' && method === 'GET') {
      return ok({ suppliers: server.suppliers, total: server.suppliers.length });
    }

    /* ── Capabilities ──────────────────────────────────────────────────── */
    if (path === '/api/fixed-assets/capabilities' && method === 'GET') {
      return ok({ capabilities: CAPABILITIES });
    }

    /* ── Reports ───────────────────────────────────────────────────────── */
    if (path === '/api/fixed-assets/reports/register' && method === 'GET') {
      return ok({ report: registerReport() });
    }

    /* ── Categories ────────────────────────────────────────────────────── */
    if (path === '/api/fixed-assets/categories' && method === 'GET') {
      const status = url.searchParams.get('status');
      const matched = status
        ? server.categories.filter((c) => c.status === status)
        : server.categories;
      return ok({ categories: matched.map(categoryView) });
    }

    if (path === '/api/fixed-assets/categories' && method === 'POST') {
      const made = writeCategory(body);
      if (made instanceof Response) return made;
      server.categories.push(made);
      audit('category', made.id, 'CATEGORY_CREATED', null, 1, { after: { code: made.code } });
      return ok({ category: categoryView(made) }, 201);
    }

    const categoryHistory = /^\/api\/fixed-assets\/categories\/([^/]+)\/history$/.exec(path);
    if (categoryHistory && method === 'GET') {
      return ok({
        events: server.audit.filter(
          (e) => e.subjectType === 'category' && e.subjectId === categoryHistory[1],
        ),
      });
    }

    const categoryArchive = /^\/api\/fixed-assets\/categories\/([^/]+)\/archive$/.exec(path);
    if (categoryArchive && method === 'POST') {
      const found = server.categories.find((c) => c.id === categoryArchive[1]);
      if (!found) return fail(404, 'not_found', 'Asset category not found.');
      if (found.version !== body.expectedVersion) return fail(409, 'conflict', STALE);

      if (body.archived) {
        const inUse = server.assets.filter(
          (a) => a.categoryId === found.id && a.status !== 'archived',
        ).length;
        if (inUse > 0) {
          return fail(409, 'conflict',
            `Category ${found.code} still has ${inUse} asset(s) in the register that are not `
            + 'archived. An asset\'s category says where its depreciation will post, so it cannot '
            + 'be retired while an asset still needs it.');
        }
      }
      found.status = body.archived ? 'archived' : 'active';
      found.version += 1;
      audit('category', found.id,
        body.archived ? 'CATEGORY_ARCHIVED' : 'CATEGORY_REACTIVATED',
        found.version - 1, found.version);
      return ok({ category: categoryView(found) });
    }

    const categoryOne = /^\/api\/fixed-assets\/categories\/([^/]+)$/.exec(path);
    if (categoryOne && method === 'GET') {
      const found = server.categories.find((c) => c.id === categoryOne[1]);
      if (!found) return fail(404, 'not_found', 'Asset category not found.');
      return ok({ category: categoryView(found) });
    }
    if (categoryOne && method === 'PATCH') {
      const found = server.categories.find((c) => c.id === categoryOne[1]);
      if (!found) return fail(404, 'not_found', 'Asset category not found.');
      if (found.version !== body.expectedVersion) return fail(409, 'conflict', STALE);
      const made = writeCategory(body, found);
      if (made instanceof Response) return made;
      Object.assign(found, made);
      audit('category', found.id, 'CATEGORY_UPDATED', found.version - 1, found.version);
      return ok({ category: categoryView(found) });
    }

    /* ── The register ──────────────────────────────────────────────────── */
    if (path === '/api/fixed-assets/assets' && method === 'GET') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const status = url.searchParams.get('status');
      let matched = server.assets;
      if (status) matched = matched.filter((a) => a.status === status);
      if (search) {
        matched = matched.filter((a) => `${a.assetCode} ${a.name} ${a.location} ${a.custodian}`
          .toLowerCase().includes(search));
      }
      return ok({ assets: matched.map(assetView) });
    }

    if (path === '/api/fixed-assets/assets' && method === 'POST') {
      const made = writeAsset(body);
      if (made instanceof Response) return made;
      server.assets.push(made);
      audit('asset', made.id, 'ASSET_REGISTERED', null, 1, {
        after: { asset_code: made.assetCode, useful_life_months: made.usefulLifeMonths },
        copiedFromCategory: { code: server.categories.find((c) => c.id === made.categoryId)?.code },
      });
      return ok({ asset: assetView(made) }, 201);
    }

    const assetHistory = /^\/api\/fixed-assets\/assets\/([^/]+)\/history$/.exec(path);
    if (assetHistory && method === 'GET') {
      return ok({
        events: server.audit.filter(
          (e) => e.subjectType === 'asset' && e.subjectId === assetHistory[1],
        ),
      });
    }

    const assetArchive = /^\/api\/fixed-assets\/assets\/([^/]+)\/archive$/.exec(path);
    if (assetArchive && method === 'POST') {
      const found = server.assets.find((a) => a.id === assetArchive[1]);
      if (!found) return fail(404, 'not_found', 'Fixed asset not found.');
      if (found.version !== body.expectedVersion) return fail(409, 'conflict', STALE);
      found.status = body.archived ? 'archived' : 'draft';
      found.version += 1;
      audit('asset', found.id, body.archived ? 'ASSET_ARCHIVED' : 'ASSET_REACTIVATED',
        found.version - 1, found.version, {}, String(body.reason ?? ''));
      return ok({ asset: assetView(found) });
    }

    const assetOne = /^\/api\/fixed-assets\/assets\/([^/]+)$/.exec(path);
    if (assetOne && method === 'GET') {
      const found = server.assets.find((a) => a.id === assetOne[1]);
      if (!found) return fail(404, 'not_found', 'Fixed asset not found.');
      return ok({ asset: assetView(found) });
    }
    if (assetOne && method === 'PATCH') {
      const found = server.assets.find((a) => a.id === assetOne[1]);
      if (!found) return fail(404, 'not_found', 'Fixed asset not found.');
      if (found.version !== body.expectedVersion) return fail(409, 'conflict', STALE);
      const made = writeAsset(body, found);
      if (made instanceof Response) return made;
      Object.assign(found, made);
      audit('asset', found.id, 'ASSET_UPDATED', found.version - 1, found.version);
      return ok({ asset: assetView(found) });
    }

    /*
     * Anything else is a 404 — including every capitalisation, depreciation,
     * disposal and schedule route, which this fake deliberately does not
     * implement. A screen that called one would fail loudly here.
     */
    return fail(404, 'not_found', `No route: ${method} ${path}`);
  }) as typeof fetch;
}
