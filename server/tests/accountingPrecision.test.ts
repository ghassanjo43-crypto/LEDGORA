/**
 * Monetary precision, enforced on the server.
 *
 * ══ The claim ═══════════════════════════════════════════════════════════════
 *
 * A currency's monetary precision is a property of the currency, and a posted
 * amount may not carry more decimals than it allows. JOD 3, USD 2, JPY 0. The
 * browser validates this too, but the browser is not a boundary — these tests
 * post straight to the service, with no interface anywhere in the path.
 *
 * ══ And the two things it must NOT mean ══════════════════════════════════════
 *
 * Storage precision is unchanged: `numeric(28,10)` and the BigInt engine stay
 * exact, so a converted or calculated value keeps every digit it legitimately
 * has. And a legacy record that already carries more decimals than its currency
 * allows must remain readable and reversible rather than being rewritten.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';
import {
  monetaryDecimalsFor,
  knownPrecisionExceptions,
  FALLBACK_MONETARY_DECIMALS,
} from '../src/services/accounting/currencyPrecision.js';
import * as Money from '../src/services/accounting/money.js';

let ctx: TestContext;

async function organization(name: string, currency: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase().replace(/\W+/gu, '-')}@precision.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({ subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO', base_currency: currency, fiscal_year_start: '01-01', data_classification: 'test' }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships').values({ organization_id: org.id, user_id: owner.id, role: 'owner' }).execute();
    return org.id;
  });
}

async function user(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status)
    VALUES (${email}, ${email}, 'Test Person', 'x', 'active')
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/** A company keeping its books in `currency`, with two postable accounts. */
async function company(name: string, currency: string) {
  const actor: AccountingActor = {
    organizationId: await organization(name, currency),
    userId: await user(`${name.toLowerCase().replace(/\W/g, '')}@test.local`),
    name: `${name} Bookkeeper`,
  };
  const cash = await accounts.createAccount(ctx.db, actor, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  });
  const sales = await accounts.createAccount(ctx.db, actor, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  });
  return { actor, cash: cash.id, sales: sales.id };
}

const entry = (debitAccount: string, creditAccount: string, value: string): journals.JournalInput => ({
  transactionDate: '2026-08-01',
  description: 'Precision test',
  lines: [
    { accountId: debitAccount, debit: value },
    { accountId: creditAccount, credit: value },
  ],
});

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/* ══ The table, and its agreement with the browser's ═══════════════════════ */

describe('currency precision metadata', () => {
  it('resolves the currencies the specification names', () => {
    expect(monetaryDecimalsFor('JOD')).toBe(3);
    expect(monetaryDecimalsFor('USD')).toBe(2);
    expect(monetaryDecimalsFor('JPY')).toBe(0);
    expect(monetaryDecimalsFor('KWD')).toBe(3);
    expect(monetaryDecimalsFor('BHD')).toBe(3);
    expect(monetaryDecimalsFor('OMR')).toBe(3);
    expect(monetaryDecimalsFor('IQD')).toBe(3);
  });

  it('normalises the code it is given', () => {
    expect(monetaryDecimalsFor('jod')).toBe(3);
    expect(monetaryDecimalsFor('  JOD  ')).toBe(3);
  });

  it('falls back once, explicitly, for a currency it does not know', () => {
    // A custom currency the server has no metadata for is posted as an ordinary
    // two-decimal currency rather than refused — refusing would make its books
    // unpostable. The value is declared in one place and pinned here.
    expect(monetaryDecimalsFor('ZZZ')).toBe(FALLBACK_MONETARY_DECIMALS);
    expect(FALLBACK_MONETARY_DECIMALS).toBe(2);
  });

  it('does not drift from the browser currency catalogue', () => {
    /*
     * The server cannot import the frontend catalogue — separate build, separate
     * module graph — so the reference data is genuinely duplicated. This test is
     * what stops the duplicate from diverging: it reads the catalogue source and
     * compares every ISO currency's minor units against this server's table.
     */
    // The suite is run both from the repository root and from `server/`, so the
    // catalogue is located relative to this file rather than to the cwd.
    const source = readFileSync(
      resolve(__dirname, '..', '..', 'src', 'data', 'currencyCatalog.ts'),
      'utf8',
    );
    const catalogue = new Map<string, number>();
    for (const m of source.matchAll(/iso\('([A-Z]{3})',\s*'[^']*',\s*'[^']*',\s*(\d)/g)) {
      catalogue.set(m[1]!, Number(m[2]));
    }
    for (const m of source.matchAll(/fiat\('([A-Z]{3})',\s*'[^']*',\s*'[^']*',\s*(\d)/g)) {
      catalogue.set(m[1]!, Number(m[2]));
    }
    expect(catalogue.size).toBeGreaterThan(150);

    const disagreements: string[] = [];
    for (const [code, decimals] of catalogue) {
      if (monetaryDecimalsFor(code) !== decimals) {
        disagreements.push(`${code}: catalogue ${decimals}, server ${monetaryDecimalsFor(code)}`);
      }
    }
    expect(disagreements).toEqual([]);

    // …and nothing in the server's exception list is absent from the catalogue.
    for (const code of Object.keys(knownPrecisionExceptions())) {
      expect(catalogue.has(code), `${code} missing from the catalogue`).toBe(true);
    }
  });
});

/* ══ The exact check ═══════════════════════════════════════════════════════ */

describe('the precision check itself', () => {
  it('judges the exact value, not its text', () => {
    // 3 decimals allowed: trailing zeros are not extra precision.
    expect(Money.exceedsPrecision(Money.toAmount('100.123'), 3)).toBe(false);
    expect(Money.exceedsPrecision(Money.toAmount('100.1230000'), 3)).toBe(false);
    expect(Money.exceedsPrecision(Money.toAmount('100.1234'), 3)).toBe(true);
    expect(Money.exceedsPrecision(Money.toAmount('100'), 0)).toBe(false);
    expect(Money.exceedsPrecision(Money.toAmount('100.1'), 0)).toBe(true);
  });

  it('does not alter the amount it judges', () => {
    // The check answers a question; it never rounds. Storage stays exact.
    const value = Money.toAmount('100.1234');
    Money.exceedsPrecision(value, 3);
    expect(Money.toDecimalString(value)).toBe('100.1234000000');
  });
});

/* ══ Enforcement, against a forged request ═════════════════════════════════ */

describe('a forged request cannot exceed the company currency precision', () => {
  it('refuses a fourth decimal for a JOD company', async () => {
    const { actor, cash, sales } = await company('Randa Trading', 'JOD');

    await expect(
      journals.createDraft(ctx.db, actor, entry(cash, sales, '100.1234')),
    ).rejects.toMatchObject({ code: 'validation_error' });

    await expect(
      journals.createDraft(ctx.db, actor, entry(cash, sales, '100.1234')),
    ).rejects.toThrow(/JOD supports a maximum of 3 decimal places/i);

    // Refused, not rounded: nothing was written at all.
    expect(await journals.listJournals(ctx.db, actor, {})).toHaveLength(0);
  });

  it('accepts exactly three decimals for a JOD company', async () => {
    const { actor, cash, sales } = await company('Randa Trading', 'JOD');
    const created = await journals.createDraft(ctx.db, actor, entry(cash, sales, '100.123'));
    expect(created.lines[0]!.debit).toBe('100.1230000000');

    const posted = await journals.postJournal(ctx.db, actor, created.id, {
      expectedVersion: created.version,
    });
    expect(posted.status).toBe('posted');
  });

  it('refuses a third decimal for a USD company', async () => {
    const { actor, cash, sales } = await company('Dollar Co', 'USD');
    await expect(
      journals.createDraft(ctx.db, actor, entry(cash, sales, '100.123')),
    ).rejects.toThrow(/USD supports a maximum of 2 decimal places/i);

    const ok = await journals.createDraft(ctx.db, actor, entry(cash, sales, '100.12'));
    expect(ok.lines[0]!.debit).toBe('100.1200000000');
  });

  it('refuses any fraction for a JPY company', async () => {
    const { actor, cash, sales } = await company('Yen KK', 'JPY');
    await expect(
      journals.createDraft(ctx.db, actor, entry(cash, sales, '100.1')),
    ).rejects.toThrow(/JPY does not support decimal places/i);

    const ok = await journals.createDraft(ctx.db, actor, entry(cash, sales, '1250'));
    expect(ok.lines[0]!.debit).toBe('1250.0000000000');
  });

  it('names the offending line and field', async () => {
    const { actor, cash, sales } = await company('Randa Trading', 'JOD');
    await expect(
      journals.createDraft(ctx.db, actor, {
        transactionDate: '2026-08-01',
        lines: [
          { accountId: cash, debit: '100.000' },
          { accountId: sales, credit: '100.0001' },
        ],
      }),
    ).rejects.toThrow(/Line 2:.*credit is 100\.0001/i);
  });

  it('applies to every write path, not only creation', async () => {
    const { actor, cash, sales } = await company('Randa Trading', 'JOD');
    const draft = await journals.createDraft(ctx.db, actor, entry(cash, sales, '100.000'));

    // Editing a draft.
    await expect(
      journals.updateDraft(ctx.db, actor, draft.id, entry(cash, sales, '100.1234'), {
        expectedVersion: draft.version,
      }),
    ).rejects.toThrow(/maximum of 3 decimal places/i);

    const posted = await journals.postJournal(ctx.db, actor, draft.id, { expectedVersion: 1 });

    // Amending a posted entry.
    await expect(
      journals.amendPostedJournal(ctx.db, actor, posted.id, entry(cash, sales, '100.1234'), {
        expectedVersion: posted.version, reason: 'Trying to slip in a fourth decimal',
      }),
    ).rejects.toThrow(/maximum of 3 decimal places/i);

    // And the replacement half of reverse-and-replace.
    await expect(
      journals.reverseAndReplace(ctx.db, actor, posted.id, entry(cash, sales, '100.1234'), {
        expectedVersion: posted.version, reason: 'Trying it through a replacement',
      }),
    ).rejects.toThrow(/maximum of 3 decimal places/i);

    // Nothing took effect: the entry is still posted and unreversed.
    const after = await journals.getJournal(ctx.db, actor, posted.id);
    expect(after.status).toBe('posted');
    expect(after.lines[0]!.debit).toBe('100.0000000000');
  });

  it('resolves each organization’s own currency', async () => {
    const jod = await company('Randa Trading', 'JOD');
    const usd = await company('Dollar Co', 'USD');

    // The same figure: legal in one company's books, not in the other's.
    const ok = await journals.createDraft(ctx.db, jod.actor, entry(jod.cash, jod.sales, '10.125'));
    expect(ok.lines[0]!.debit).toBe('10.1250000000');
    await expect(
      journals.createDraft(ctx.db, usd.actor, entry(usd.cash, usd.sales, '10.125')),
    ).rejects.toThrow(/USD supports a maximum of 2/i);
  });
});

/* ══ Internal precision, unchanged ═════════════════════════════════════════ */

describe('storage and arithmetic precision are untouched', () => {
  it('still stores ten decimal places', async () => {
    const { rows } = await sql<{ numeric_scale: number; column_name: string }>`
      SELECT column_name, numeric_scale FROM information_schema.columns
       WHERE table_name = 'journal_lines'
         AND column_name IN ('debit_transaction','credit_transaction','debit_functional','credit_functional')
    `.execute(ctx.db);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.numeric_scale, row.column_name).toBe(10);
  });

  it('keeps the BigInt engine exact for values a currency could not express', () => {
    /*
     * Monetary precision governs POSTED amounts. It does not reduce the engine's
     * internal precision, which future foreign-currency translation depends on —
     * a rate-converted figure legitimately has more digits than the currency it
     * came from.
     */
    const a = Money.toAmount('0.1');
    const b = Money.toAmount('0.2');
    expect(Money.toDecimalString(Money.add(a, b))).toBe('0.3000000000');
    expect(Money.equals(Money.add(a, b), Money.toAmount('0.3'))).toBe(true);

    const converted = Money.multiply(Money.toAmount('100'), Money.toAmount('0.7091234567'));
    expect(Money.toDecimalString(converted)).toBe('70.9123456700');
  });
});

/* ══ Historical records ════════════════════════════════════════════════════ */

describe('records that already exceed the precision', () => {
  /** A legacy entry, written straight to the table as an import would be. */
  async function legacyOverPreciseEntry(actor: AccountingActor, cash: string, sales: string) {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO journal_entries (
        organization_id, journal_number, transaction_date, posting_date, status,
        transaction_currency, functional_currency, exchange_rate, posted_at, version
      ) VALUES (
        ${actor.organizationId}, 'JE-900001', '2025-01-15', '2025-01-15', 'posted',
        'JOD', 'JOD', 1, '2025-01-15T00:00:00Z', 1
      ) RETURNING id
    `.execute(ctx.db);
    const id = rows[0]!.id;
    for (const line of [
      { n: 1, account: cash, debit: '100.1234', credit: '0' },
      { n: 2, account: sales, debit: '0', credit: '100.1234' },
    ]) {
      await sql`
        INSERT INTO journal_lines (
          organization_id, journal_entry_id, line_number, account_id,
          debit_transaction, credit_transaction, debit_functional, credit_functional
        ) VALUES (
          ${actor.organizationId}, ${id}, ${line.n}, ${line.account},
          ${line.debit}, ${line.credit}, ${line.debit}, ${line.credit}
        )
      `.execute(ctx.db);
    }
    return id;
  }

  it('are not rewritten, and stay readable exactly as stored', async () => {
    const { actor, cash, sales } = await company('Randa Trading', 'JOD');
    const id = await legacyOverPreciseEntry(actor, cash, sales);

    const stored = await journals.getJournal(ctx.db, actor, id);
    // Four decimals, preserved. Reading must never round what it finds.
    expect(stored.lines[0]!.debit).toBe('100.1234000000');
  });

  it('can still be reversed, so a legacy record is not trapped in the ledger', async () => {
    /*
     * The reversal copies the original's figures. Applying the new rule to that
     * copy would refuse it — and an entry that cannot be reversed cannot be
     * corrected, which would make the restriction worse than the problem.
     */
    const { actor, cash, sales } = await company('Randa Trading', 'JOD');
    const id = await legacyOverPreciseEntry(actor, cash, sales);

    const { reversal } = await journals.reverseJournal(ctx.db, actor, id, {
      expectedVersion: 1, reason: 'Withdrawing a legacy over-precise entry',
    });
    expect(reversal.status).toBe('posted');
    expect(reversal.lines.find((l) => l.accountId === cash)!.credit).toBe('100.1234000000');
  });
});
