/**
 * Fixed-asset reports F1 can honestly produce.
 *
 * ══ Why there is no reconciliation report here ═══════════════════════════════
 *
 * A fixed-asset register reconciles to the general ledger by comparing what the
 * register says an asset cost and has depreciated against what the mapped
 * accounts actually hold. F1 posts nothing and stores neither figure, so both
 * sides of that comparison would be zero — and a reconciliation that reports
 * "balanced" because it compared nothing to nothing is worse than no
 * reconciliation at all. It is a green light somebody would sign under.
 *
 * The same reasoning removes every schedule, movement, depreciation, carrying
 * amount, gain, loss and impairment report. Each is a statement about postings.
 *
 * ══ What is left, and why it is worth having ════════════════════════════════
 *
 * Three questions this slice can answer from its own records, and answer
 * exactly:
 *
 *   · what is registered, grouped by category and by status;
 *   · what has been archived;
 *   · what is NOT configured well enough for depreciation to ever run.
 *
 * The last one is the useful one. F2 will refuse to post through a category
 * that has no accumulated-depreciation account, and finding that out one asset
 * at a time on the day the first depreciation run is attempted is how a month
 * end goes wrong. This lists it now, while there is time.
 *
 * ══ Counts, never money ══════════════════════════════════════════════════════
 *
 * Every figure below is a COUNT of records. There is no acquisition-cost total,
 * because there is no acquisition cost: the product records cost when it
 * capitalises, and this slice does not capitalise. A total here would be a
 * money column a reader would reasonably compare to a balance sheet, and it
 * would agree with nothing.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import type { FixedAssetActor } from './fixedAssetCore.js';

export interface RegisterByCategoryRow {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  categoryStatus: string;
  draftAssets: number;
  archivedAssets: number;
  totalAssets: number;
  /** Sum of `quantity`: identical units, not a valuation and not stock on hand. */
  totalUnits: number;
  mappingComplete: boolean;
}

export interface ConfigurationIssue {
  subjectType: 'category' | 'asset';
  subjectId: string;
  code: string;
  name: string;
  /** Machine-readable so a screen can group; the sentence says what to do. */
  issue: string;
  detail: string;
}

export interface RegisterReport {
  /** Said in the payload so no reader has to infer it from an absence. */
  basis: 'register-master-data';
  reconcilesToGeneralLedger: false;
  note: string;
  byCategory: RegisterByCategoryRow[];
  totals: {
    categories: number;
    activeCategories: number;
    archivedCategories: number;
    assets: number;
    draftAssets: number;
    archivedAssets: number;
    totalUnits: number;
  };
  configurationIssues: ConfigurationIssue[];
}

export const REGISTER_REPORT_NOTE =
  'These are REGISTER figures — counts of records somebody has entered. They are not general-ledger '
  + 'balances and do not reconcile to one: this slice records no acquisition cost and posts no '
  + 'journal, so there is nothing on the ledger side to compare them with. Cost, accumulated '
  + 'depreciation, carrying amount and the reconciliation between them arrive with capitalisation '
  + 'and depreciation posting.';

/**
 * One pass over the register, grouped by category.
 *
 * Aggregated in SQL rather than by loading every asset: a register is the one
 * fixed-asset table that genuinely grows, and a report that reads it all into
 * memory to count it stops working exactly when it starts being useful.
 */
export async function registerReport(
  db: Kysely<Database>,
  actor: FixedAssetActor,
): Promise<RegisterReport> {
  const categories = await db
    .selectFrom('fixed_asset_categories as c')
    .select([
      'c.id', 'c.code', 'c.name', 'c.status',
      'c.asset_cost_account_id',
      'c.accumulated_depreciation_account_id',
      'c.depreciation_expense_account_id',
      'c.default_method',
    ])
    .where('c.organization_id', '=', actor.organizationId)
    .where('c.company_id', '=', actor.companyId)
    .orderBy('c.code', 'asc')
    .execute();

  const grouped = await db
    .selectFrom('fixed_assets')
    .select(['category_id', 'status'])
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .select((eb) => eb.fn.sum<string>('quantity').as('units'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .groupBy(['category_id', 'status'])
    .execute();

  const byCategory: RegisterByCategoryRow[] = categories.map((category) => {
    const rows = grouped.filter((row) => row.category_id === category.id);
    const draft = rows.find((row) => row.status === 'draft');
    const archived = rows.find((row) => row.status === 'archived');
    const draftAssets = Number(draft?.n ?? '0');
    const archivedAssets = Number(archived?.n ?? '0');
    return {
      categoryId: category.id,
      categoryCode: category.code,
      categoryName: category.name,
      categoryStatus: category.status,
      draftAssets,
      archivedAssets,
      totalAssets: draftAssets + archivedAssets,
      totalUnits: rows.reduce((sum, row) => sum + Number(row.units ?? '0'), 0),
      mappingComplete: Boolean(
        category.asset_cost_account_id
        && category.accumulated_depreciation_account_id
        && category.depreciation_expense_account_id,
      ),
    };
  });

  /* ── What would stop depreciation ever running ───────────────────────────── */

  const configurationIssues: ConfigurationIssue[] = [];

  for (const category of categories) {
    /*
     * A category that does not depreciate needs no depreciation accounts. Land
     * is the case, and demanding an accumulated-depreciation account for it
     * would be a warning nobody could ever clear.
     */
    const depreciates = category.default_method !== 'none';

    const missing: string[] = [];
    if (!category.asset_cost_account_id) missing.push('asset cost');
    if (depreciates && !category.accumulated_depreciation_account_id) {
      missing.push('accumulated depreciation');
    }
    if (depreciates && !category.depreciation_expense_account_id) {
      missing.push('depreciation expense');
    }

    if (missing.length > 0) {
      configurationIssues.push({
        subjectType: 'category',
        subjectId: category.id,
        code: category.code,
        name: category.name,
        issue: 'missing-account-mapping',
        detail:
          `Category ${category.code} has no ${missing.join(' account, no ')} account. Assets in it `
          + 'can be registered, but the depreciation posting this configuration exists for will be '
          + 'refused until every mapping is chosen.',
      });
    }
  }

  /*
   * An asset in an archived category, still working.
   *
   * Archiving a category is refused while unarchived assets need it, so this is
   * a state the API will not create. It is reported anyway, because a database
   * that has been through a restore, a migration or a direct edit can hold one,
   * and a configuration report that only finds problems it caused itself is not
   * a check.
   */
  const orphaned = await db
    .selectFrom('fixed_assets as a')
    .innerJoin('fixed_asset_categories as c', (join) => join
      .onRef('c.id', '=', 'a.category_id')
      .onRef('c.organization_id', '=', 'a.organization_id')
      .onRef('c.company_id', '=', 'a.company_id'))
    .select(['a.id', 'a.asset_code', 'a.name', 'c.code as category_code'])
    .where('a.organization_id', '=', actor.organizationId)
    .where('a.company_id', '=', actor.companyId)
    .where('a.status', '<>', 'archived')
    .where('c.status', '=', 'archived')
    .orderBy('a.asset_code', 'asc')
    .execute();

  for (const asset of orphaned) {
    configurationIssues.push({
      subjectType: 'asset',
      subjectId: asset.id,
      code: asset.asset_code,
      name: asset.name,
      issue: 'archived-category',
      detail:
        `Asset ${asset.asset_code} is in category ${asset.category_code}, which is archived. Move it `
        + 'to an active category, or archive the asset.',
    });
  }

  const totals = byCategory.reduce(
    (sum, row) => ({
      categories: sum.categories + 1,
      activeCategories: sum.activeCategories + (row.categoryStatus === 'active' ? 1 : 0),
      archivedCategories: sum.archivedCategories + (row.categoryStatus === 'archived' ? 1 : 0),
      assets: sum.assets + row.totalAssets,
      draftAssets: sum.draftAssets + row.draftAssets,
      archivedAssets: sum.archivedAssets + row.archivedAssets,
      totalUnits: sum.totalUnits + row.totalUnits,
    }),
    {
      categories: 0,
      activeCategories: 0,
      archivedCategories: 0,
      assets: 0,
      draftAssets: 0,
      archivedAssets: 0,
      totalUnits: 0,
    },
  );

  return {
    basis: 'register-master-data',
    reconcilesToGeneralLedger: false,
    note: REGISTER_REPORT_NOTE,
    byCategory,
    totals,
    configurationIssues,
  };
}
