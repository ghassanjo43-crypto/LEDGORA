/**
 * The accounts a server-backed invoice posts against.
 *
 * ── Why this has to exist ────────────────────────────────────────────────────
 * The browser resolves its posting accounts by CODE — `accountByCode('2270')`
 * for output tax, the customer's `defaultReceivableAccount` or `1221` for the
 * receivable. Those codes address the BROWSER's chart. The server's
 * `issueInvoice` wants account IDs from the SERVER's `accounts` table, and the
 * same account has a different id in each.
 *
 * So the codes stay the contract and this translates them. Keeping the codes as
 * the shared language is deliberate: they are what a bookkeeper recognises, and
 * they survive the two charts being imported and re-imported independently.
 *
 * ── Why a missing account is an error, not a fallback ────────────────────────
 * There is no "post it somewhere sensible" here. An invoice posted to the wrong
 * receivable reconciles to nothing, and an invoice whose tax lands in revenue
 * overstates income and understates a liability to a tax authority. Both are
 * far more expensive to unpick than a refusal at the point of issue, so this
 * returns what is missing and lets the caller say so.
 */
import { accountingApi, type ServerAccount } from '@/services/api/accountingApi';

/** The codes the browser chart uses, kept as the shared vocabulary. */
export const RECEIVABLE_CODES = ['1200', '1221'] as const;
export const TAX_PAYABLE_CODE = '2270';

export interface PostingAccounts {
  receivableAccountId: string;
  /** Absent when the chart has no output-tax account; only fatal if tax is due. */
  taxAccountId?: string;
  chargesAccountId?: string;
}

export interface PostingAccountsResult {
  accounts?: PostingAccounts;
  /** Human-readable, naming the code that could not be found. */
  error?: string;
}

/**
 * Resolve against the server's chart.
 *
 * `preferredReceivableCode` carries the customer's own default when they have
 * one, so a workspace that segregates receivables by customer keeps doing so.
 */
export async function resolveServerPostingAccounts(options: {
  preferredReceivableCode?: string;
  chargesCode?: string;
  /** Injected in tests; otherwise fetched. */
  accounts?: ServerAccount[];
} = {}): Promise<PostingAccountsResult> {
  let chart: ServerAccount[];
  try {
    chart = options.accounts ?? (await accountingApi.list());
  } catch (cause) {
    return {
      error: `Could not read the chart of accounts to post this invoice: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }

  const byCode = new Map(chart.map((account) => [account.accountCode, account]));
  const find = (code: string | undefined): ServerAccount | undefined =>
    code ? byCode.get(code) : undefined;

  const receivable =
    find(options.preferredReceivableCode) ?? RECEIVABLE_CODES.map(find).find(Boolean);

  if (!receivable) {
    return {
      error:
        'No trade receivables account was found on the server chart '
        + `(looked for ${RECEIVABLE_CODES.join(' or ')}). Add one, then issue this invoice again.`,
    };
  }

  /*
   * A header account cannot be posted to. The server would refuse anyway, but
   * its message names an id rather than the code a bookkeeper would recognise.
   */
  if (!receivable.isPostable) {
    return {
      error: `Account ${receivable.accountCode} (${receivable.accountName}) is a heading and cannot be posted to.`,
    };
  }

  const tax = find(TAX_PAYABLE_CODE);
  const charges = find(options.chargesCode);

  return {
    accounts: {
      receivableAccountId: receivable.id,
      taxAccountId: tax?.isPostable ? tax.id : undefined,
      chargesAccountId: charges?.isPostable ? charges.id : undefined,
    },
  };
}
