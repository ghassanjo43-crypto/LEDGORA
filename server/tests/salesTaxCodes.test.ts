/**
 * Controlled tax codes: what the books own, and what they refuse.
 *
 * ══ Why the refusals get as much room as the happy path ══════════════════════
 *
 * The browser tax model has ten categories and four calculation methods. This
 * server implements five and two. The gap is not an oversight to be quietly
 * tolerated — each absent value names accounting the server has no controlled
 * mapping for, and a half-implemented reverse charge would post a self-assessed
 * liability to an account nobody chose. So every refusal is pinned by name,
 * because a refusal that degrades into silent acceptance is the failure mode
 * that reaches an audit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as taxCodes from '../src/services/invoicing/taxCodeService.js';

let ctx: TestContext;
let actor: AccountingActor;
let chart: { output: string; sales: string; header: string };

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@tax.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test',
    } as never).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' } as never).execute();
    return org.id;
  });
}

async function company(org: string, reference: string): Promise<string> {
  const row = await ctx.db.insertInto('companies').values({
    organization_id: org, client_reference: reference,
    legal_name: `Books ${reference}`, adopted_at: sql`now()`,
  } as never).returning('id').executeTakeFirstOrThrow();
  await ctx.db.insertInto('company_settings')
    .values({ organization_id: org, company_id: row.id } as never)
    .onConflict((oc) => oc.columns(['organization_id', 'company_id']).doNothing()).execute();
  return row.id;
}

async function person(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Tax', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

const create = (over: Record<string, unknown> = {}) =>
  taxCodes.createTaxCode(ctx.db, actor, {
    code: 'VAT16', name: 'Standard-rated sales', category: 'standard',
    calculationMethod: 'exclusive', rate: '16', outputTaxAccountId: chart.output,
    effectiveFrom: '2026-01-01',
    ...over,
  } as never);

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Tax');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_tax'),
    userId: await person('tax@tax.test'),
    name: 'Tax Tester',
  };
  /* A heading, so it can take a child — and so it can never take a posting. */
  const header = await accounts.createAccount(ctx.db, actor, {
    accountCode: '2200', accountName: 'Liabilities', accountType: 'liability',
    isPostable: false,
  });
  chart = {
    output: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2270', accountName: 'Output tax payable', accountType: 'liability',
    })).id,
    sales: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
    header: header.id,
  };
  /* A child makes 2200 a heading, which is what makes it non-postable. */
  await accounts.createAccount(ctx.db, actor, {
    accountCode: '2201', accountName: 'Under the heading', accountType: 'liability',
    parentAccountId: header.id,
  });
});
afterEach(async () => { await ctx.close(); });

/* ══ The five categories stay five ═════════════════════════════════════════ */

describe('legally distinct categories', () => {
  it('keeps zero-rated, exempt and out-of-scope APART', async () => {
    /*
     * All three charge nothing. Collapsing them into one "zero tax" state is
     * the easy mistake and the expensive one: a zero-rated export, an exempt
     * supply and an out-of-scope item go in three different places in a return,
     * and one of them is not in the return at all.
     */
    for (const category of ['zero-rated', 'exempt', 'out-of-scope'] as const) {
      const code = await create({ code: `Z-${category}`, category, rate: '0', outputTaxAccountId: null });
      expect(code.category).toBe(category);
      expect(code.outputTaxAccountId).toBeNull();
    }
  });

  it('accepts standard and reduced as separate taxable categories', async () => {
    const standard = await create({ code: 'VAT16', category: 'standard', rate: '16' });
    const reduced = await create({ code: 'VAT04', category: 'reduced', rate: '4' });
    expect(standard.category).toBe('standard');
    expect(reduced.category).toBe('reduced');
    expect(standard.rateVersions[0]!.rate).toBe('16.000000');
    expect(reduced.rateVersions[0]!.rate).toBe('4.000000');
  });

  it('refuses a zero-tax category that names an output account', async () => {
    /* An account here would imply a credit that must never be posted. */
    await expect(create({ code: 'EX1', category: 'exempt', rate: '0', outputTaxAccountId: chart.output }))
      .rejects.toThrow(/posts no tax, so it has no output tax account/i);
  });

  it('refuses a zero-tax category carrying a rate', async () => {
    await expect(create({ code: 'EX2', category: 'exempt', rate: '16', outputTaxAccountId: null }))
      .rejects.toThrow(/charges no tax, so it cannot carry a rate/i);
  });
});

/* ══ Unsupported treatments are refused BY NAME ════════════════════════════ */

describe('unsupported tax treatments', () => {
  it.each([
    ['reverse-charge', /self-assessed output AND input tax/i],
    ['import', /assessed at the border/i],
    ['withholding', /payment or receipt stage/i],
    ['custom', /no defined accounting treatment/i],
  ])('refuses the %s category, saying why', async (category, pattern) => {
    await expect(create({ code: `X-${category}`, category })).rejects.toThrow(pattern);
  });

  it.each([
    ['compound', /each rate to the base plus the previous tax/i],
    ['self-assessed', /debit and a credit/i],
    ['fixed', /per unit or per document rather than a percentage/i],
  ])('refuses the %s calculation method, saying why', async (method, pattern) => {
    await expect(create({ code: `M-${method}`, calculationMethod: method })).rejects.toThrow(pattern);
  });

  it('names the supported set so the message is actionable', async () => {
    const error = await create({ category: 'reverse-charge' }).then(() => null, (e) => e as Error);
    expect(error!.message).toMatch(/standard, reduced, zero-rated, exempt, out-of-scope/);
    expect(error!.message).toMatch(/nothing has been saved/i);
  });
});

/* ══ The output account ════════════════════════════════════════════════════ */

describe('the output tax account', () => {
  it('refuses an account from ANOTHER company', async () => {
    const otherOrg = await organization('Rival');
    const otherCompany = await company(otherOrg, 'co_rival');
    const foreign = await accounts.createAccount(ctx.db, {
      organizationId: otherOrg, companyId: otherCompany, userId: actor.userId, name: 'Rival',
    }, { accountCode: '2270', accountName: 'Their output tax', accountType: 'liability' });

    await expect(create({ outputTaxAccountId: foreign.id }))
      .rejects.toThrow(/does not exist in these books/i);
  });

  it('refuses a heading account', async () => {
    await expect(create({ outputTaxAccountId: chart.header }))
      .rejects.toThrow(/cannot receive postings/i);
  });

  it('refuses an archived account', async () => {
    /* The chart requires an archived account to be inactive too. */
    await sql`UPDATE accounts SET archived = true, active = false WHERE id = ${chart.output}`.execute(ctx.db);
    await expect(create({})).rejects.toThrow(/cannot receive postings/i);
  });

  it('refuses an inactive account', async () => {
    await sql`UPDATE accounts SET active = false WHERE id = ${chart.output}`.execute(ctx.db);
    await expect(create({})).rejects.toThrow(/cannot receive postings/i);
  });

  it('refuses a blocked account', async () => {
    await sql`UPDATE accounts SET blocked = true WHERE id = ${chart.output}`.execute(ctx.db);
    await expect(create({})).rejects.toThrow(/cannot receive postings/i);
  });
});

/* ══ Identity ══════════════════════════════════════════════════════════════ */

describe('code identity', () => {
  it('refuses a duplicate code in the same books, case-insensitively', async () => {
    await create({ code: 'VAT16' });
    await expect(create({ code: 'vat16', name: 'Another' }))
      .rejects.toThrow(/already exists in these books/i);
  });

  it('lets two different COMPANIES hold the same code', async () => {
    await create({ code: 'VAT16' });
    const second = await company(actor.organizationId, 'co_second');
    const secondActor = { ...actor, companyId: second };
    const output = await accounts.createAccount(ctx.db, secondActor, {
      accountCode: '2270', accountName: 'Output tax', accountType: 'liability',
    });
    const created = await taxCodes.createTaxCode(ctx.db, secondActor, {
      code: 'VAT16', name: 'Standard', category: 'standard', calculationMethod: 'exclusive',
      rate: '16', outputTaxAccountId: output.id, effectiveFrom: '2026-01-01',
    } as never);
    expect(created.code).toBe('VAT16');
  });

  it('does not list another company\'s codes', async () => {
    await create({ code: 'VAT16' });
    const second = await company(actor.organizationId, 'co_second');
    const listed = await taxCodes.listTaxCodes(ctx.db, { ...actor, companyId: second });
    expect(listed).toHaveLength(0);
  });
});

/* ══ Effective-dated rates ═════════════════════════════════════════════════ */

describe('effective-dated rates', () => {
  it('resolves the rate in force on a date, at the BOUNDARY', async () => {
    const code = await create({ code: 'VAT16', rate: '16' });
    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '18', effectiveFrom: '2026-07-01', expectedVersion: code.version,
    });

    const before = await taxCodes.resolveTaxForDate(ctx.db, actor, code.id, '2026-06-30');
    const onTheDay = await taxCodes.resolveTaxForDate(ctx.db, actor, code.id, '2026-07-01');

    /* The boundary is inclusive at the start: an invoice dated the first day of
     * the new rate charges the new rate. */
    expect(before.rate).toBe(160000000000n);
    expect(onTheDay.rate).toBe(180000000000n);
  });

  it('end-dates the open predecessor rather than leaving an overlap', async () => {
    const code = await create({ code: 'VAT16', rate: '16' });
    const after = await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '18', effectiveFrom: '2026-07-01', expectedVersion: code.version,
    });
    const original = after.rateVersions.find((v) => v.rate.startsWith('16'))!;
    /* Two rates applying on one date would make the tax that day a matter of
     * which row was read first. */
    expect(original.effectiveTo).toBe('2026-06-30');
  });

  it('refuses an overlapping period', async () => {
    const code = await create({ code: 'VAT16', rate: '16' });
    const v2 = await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '18', effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31', expectedVersion: code.version,
    });
    await expect(taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '20', effectiveFrom: '2026-09-01', expectedVersion: v2.version,
    })).rejects.toThrow(/may not overlap/i);
  });

  it('refuses a date with NO rate in force rather than falling back', async () => {
    const code = await create({ code: 'VAT16', rate: '16', effectiveFrom: '2026-06-01' });
    await expect(taxCodes.resolveTaxForDate(ctx.db, actor, code.id, '2026-01-01'))
      .rejects.toThrow(/does not apply on 2026-01-01/i);
  });
});

/* ══ Status ════════════════════════════════════════════════════════════════ */

describe('archiving and deactivation', () => {
  it('refuses an archived code on a NEW document, and says the old ones are safe', async () => {
    const code = await create({ code: 'VAT16' });
    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'archived', code.version);

    const error = await taxCodes.resolveTaxForDate(ctx.db, actor, code.id, '2026-06-01')
      .then(() => null, (e) => e as Error);
    expect(error!.message).toMatch(/archived and cannot be put on a new invoice/i);
    expect(error!.message).toMatch(/already issued under it keep it/i);
  });

  it('refuses an inactive code on a new document', async () => {
    const code = await create({ code: 'VAT16' });
    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'inactive', code.version);
    await expect(taxCodes.resolveTaxForDate(ctx.db, actor, code.id, '2026-06-01'))
      .rejects.toThrow(/inactive/i);
  });

  it('hides archived codes from the default list but keeps them retrievable', async () => {
    const code = await create({ code: 'VAT16' });
    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'archived', code.version);

    expect(await taxCodes.listTaxCodes(ctx.db, actor)).toHaveLength(0);
    expect(await taxCodes.listTaxCodes(ctx.db, actor, { includeArchived: true })).toHaveLength(1);
    /* Retrievable is the point: an invoice names it, so it must stay readable. */
    expect((await taxCodes.getTaxCode(ctx.db, actor, code.id)).status).toBe('archived');
  });
});

/* ══ Concurrency and immutability ══════════════════════════════════════════ */

describe('concurrent and unsafe edits', () => {
  it('refuses a stale version', async () => {
    const code = await create({ code: 'VAT16' });
    await taxCodes.updateTaxCode(ctx.db, actor, code.id, {
      name: 'Renamed', outputTaxAccountId: chart.output, expectedVersion: code.version,
    });
    await expect(taxCodes.updateTaxCode(ctx.db, actor, code.id, {
      name: 'Renamed again', outputTaxAccountId: chart.output, expectedVersion: code.version,
    })).rejects.toThrow(/changed by another user/i);
  });

  it('refuses an edit carrying NO version at all', async () => {
    const code = await create({ code: 'VAT16' });
    await expect(taxCodes.updateTaxCode(ctx.db, actor, code.id, {
      name: 'Renamed', outputTaxAccountId: chart.output,
    })).rejects.toThrow(/did not carry the version/i);
  });

  it('refuses to change a CATEGORY, because issued lines froze it', async () => {
    const code = await create({ code: 'VAT16', category: 'standard' });
    await expect(taxCodes.updateTaxCode(ctx.db, actor, code.id, {
      name: 'Standard', category: 'exempt', outputTaxAccountId: chart.output,
      expectedVersion: code.version,
    })).rejects.toThrow(/category cannot be changed/i);
  });

  it('lets only ONE of two racing rate additions win', async () => {
    /*
     * Both read the same version, so the second is refused by the optimistic
     * token rather than quietly appending a second rate for one date. Genuine
     * multi-connection concurrency is proved against a real PostgreSQL server
     * in the disposable probe — PGlite runs in one process and cannot show it.
     */
    const code = await create({ code: 'VAT16', rate: '16' });
    const first = await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '18', effectiveFrom: '2026-07-01', expectedVersion: code.version,
    });
    expect(first.rateVersions).toHaveLength(2);

    await expect(taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '20', effectiveFrom: '2026-07-01', expectedVersion: code.version,
    })).rejects.toThrow(/changed by another user/i);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM tax_rate_versions WHERE tax_code_id = ${code.id}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

describe('audit history', () => {
  it('records creation, edit, rate addition and archiving', async () => {
    const code = await create({ code: 'VAT16' });
    const renamed = await taxCodes.updateTaxCode(ctx.db, actor, code.id, {
      name: 'Renamed', outputTaxAccountId: chart.output, expectedVersion: code.version,
    });
    const rated = await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '18', effectiveFrom: '2026-07-01', expectedVersion: renamed.version,
    });
    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'archived', rated.version);

    const history = await taxCodes.taxCodeHistory(ctx.db, actor, code.id);
    expect(history.map((e) => e.action)).toEqual([
      'TAX_CODE_ARCHIVED', 'TAX_RATE_VERSION_ADDED', 'TAX_CODE_UPDATED', 'TAX_CODE_CREATED',
    ]);
    expect(history.every((e) => e.actorName === 'Tax Tester')).toBe(true);
  });
});
