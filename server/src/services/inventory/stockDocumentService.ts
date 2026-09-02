/**
 * Stock documents: receipts, issues, transfers, adjustments — and their
 * reversals.
 *
 * ══ One transaction, or nothing ══════════════════════════════════════════════
 *
 * Locks, validation, costing, the movements, the journal, the numbering and the
 * audit line all happen inside one database transaction. A failure anywhere
 * takes the whole thing back, because a document that moved stock without
 * posting its journal — or posted a journal with no stock behind it — is a set
 * of books nobody can reconcile and nobody can find the cause of.
 *
 * ══ Idempotency is a constraint, not a check ═════════════════════════════════
 *
 * Every posting carries an idempotency key, unique per company. A retry after a
 * timeout — which is exactly when the first attempt may still be in flight —
 * loses the insert race and is answered with the document it already made. The
 * journal has the same guarantee independently, through
 * `journal_entries_source_event_unique`.
 *
 * ══ What is refused, by name ═════════════════════════════════════════════════
 *
 * Negative stock; backdating behind an item's last movement; FIFO and standard
 * items; opening balances; stock counts; anything touching a bill, an invoice,
 * a lot, a serial, a bin, a second unit or another currency. Each of those is a
 * decision this product has not made or a slice that does not exist, and a
 * partial implementation would be worse than a refusal that says so.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import { assertPeriodAccepts } from '../accounting/periodService.js';
import { postSourceJournalIn } from '../accounting/sourcePostingService.js';
import { reverseJournalIn } from '../accounting/journalService.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import type { AccountingActor } from '../accounting/audit.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import {
  type InventoryActor,
  assertVersion,
  writeInventoryAudit,
} from './inventoryCore.js';
import {
  type Position,
  SUPPORTED_VALUATION,
  UNSUPPORTED_VALUATION,
  inboundCost,
  lockItems,
  latestPostingDate,
  onHandAt,
  outboundCost,
  positionOf,
  toQuantity,
  toUnitCost,
} from './stockLedger.js';

export type DocumentKind = 'receipt' | 'issue' | 'transfer' | 'adjustment';

/**
 * The counter-movement's type.
 *
 * A receipt reverses as an adjustment out and an issue as an adjustment in,
 * because the opposite of receiving is not issuing — it is stock leaving for a
 * reason that is not consumption. Transfers mirror themselves.
 */
const OPPOSITE_TYPE: Record<string, string> = {
  receipt: 'adjustment-out',
  issue: 'adjustment-in',
  'transfer-in': 'transfer-out',
  'transfer-out': 'transfer-in',
  'adjustment-in': 'adjustment-out',
  'adjustment-out': 'adjustment-in',
};

export interface LineInput {
  itemId: string;
  warehouseId?: string;
  quantity: string;
  /** Receipts and positive adjustments only; never trusted for an outbound. */
  unitCost?: string | null;
  /** Issues only: where the cost lands. Falls back to the profile's default. */
  expenseAccountId?: string | null;
  /** Adjustments only. */
  direction?: 'in' | 'out';
}

export interface PostDocumentInput {
  kind: DocumentKind;
  movementDate: string;
  postingDate?: string;
  reference?: string;
  memo?: string;
  reason?: string;
  idempotencyKey: string;
  /** Transfers only. */
  sourceWarehouseId?: string;
  destinationWarehouseId?: string;
  lines: LineInput[];
}

export interface MovementRecord {
  id: string;
  lineNumber: number;
  movementType: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  baseUnitId: string;
  baseUnitCode: string;
  direction: 'in' | 'out';
  quantity: string;
  unitCost: string;
  totalCost: string;
  inventoryAccountId: string;
  offsetAccountId: string | null;
  movementDate: string;
  postingDate: string;
  status: string;
  reversalOfMovementId: string | null;
  reversedByMovementId: string | null;
}

export interface DocumentRecord {
  id: string;
  documentNumber: string;
  kind: string;
  movementDate: string;
  postingDate: string;
  reference: string;
  memo: string;
  reason: string;
  status: string;
  journalEntryId: string | null;
  reversalOfDocumentId: string | null;
  reversedByDocumentId: string | null;
  reversalReason: string;
  version: number;
  createdAt: string | null;
  movements: MovementRecord[];
}

/* ── Refusals this slice makes by name ─────────────────────────────────────── */

export const NEGATIVE_STOCK_REFUSED =
  'This would leave less than nothing in the warehouse. Negative stock is not permitted: the '
  + 'product models a policy for it in the browser only, and no controlled server setting exists, '
  + 'so allowing it here would be inventing an accounting position rather than applying one. '
  + 'Receive the stock first, or adjust it in.';

export const BACKDATING_REFUSED =
  'A stock movement cannot be posted before this item\'s most recent one. Costs already posted are '
  + 'never recalculated in this product — an issue keeps the average it was costed at — so a '
  + 'movement inserted behind an existing one would leave that issue costed against a position it '
  + 'no longer describes. Post it on or after that date, or reverse the later documents first.';

export const UNSUPPORTED_DEPENDENCY: Record<string, string> = {
  lotId: 'lot tracking',
  serialNumbers: 'serial-number tracking',
  expiryDate: 'expiry dates',
  binId: 'bin locations',
  locationId: 'bin locations',
  unitId: 'alternate units of measure',
  currency: 'foreign-currency stock',
  exchangeRate: 'foreign-currency stock',
  projectId: 'project dimensions',
  costCenterId: 'cost-centre dimensions',
  billId: 'purchase integration',
  invoiceId: 'sales integration',
  purchaseOrderId: 'purchase orders',
  landedCost: 'landed costs',
};

/* A calendar date, read the only way a bare `date` column may be read. */
const iso = (value: unknown): string | null =>
  (value === null || value === undefined ? null : toCalendarDate(value));

const isoStamp = (value: unknown): string | null =>
  (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrateMovement(row: any): MovementRecord {
  return {
    id: row.id,
    lineNumber: Number(row.line_number),
    movementType: row.movement_type,
    itemId: row.item_id,
    itemCode: row.item_code ?? '',
    itemName: row.item_name ?? '',
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code ?? '',
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.base_unit_code ?? '',
    direction: row.direction,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    totalCost: row.total_cost,
    inventoryAccountId: row.inventory_account_id,
    offsetAccountId: row.offset_account_id ?? null,
    movementDate: iso(row.movement_date) ?? '',
    postingDate: iso(row.posting_date) ?? '',
    status: row.status,
    reversalOfMovementId: row.reversal_of_movement_id ?? null,
    reversedByMovementId: row.reversed_by_movement_id ?? null,
  };
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrateDocument(row: any, movements: MovementRecord[]): DocumentRecord {
  return {
    id: row.id,
    documentNumber: row.document_number,
    kind: row.kind,
    movementDate: iso(row.movement_date) ?? '',
    postingDate: iso(row.posting_date) ?? '',
    reference: row.reference ?? '',
    memo: row.memo ?? '',
    reason: row.reason ?? '',
    status: row.status,
    journalEntryId: row.journal_entry_id ?? null,
    reversalOfDocumentId: row.reversal_of_document_id ?? null,
    reversedByDocumentId: row.reversed_by_document_id ?? null,
    reversalReason: row.reversal_reason ?? '',
    version: Number(row.version),
    createdAt: isoStamp(row.created_at),
    movements,
  };
}

export async function getDocument(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<DocumentRecord> {
  const row = await db
    .selectFrom('inventory_documents')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Stock document');

  const movements = await db
    .selectFrom('inventory_movements')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('document_id', '=', id)
    .orderBy('line_number', 'asc')
    .execute();

  return hydrateDocument(row, movements.map(hydrateMovement));
}

export interface ListDocumentsQuery {
  kind?: DocumentKind;
  status?: 'posted' | 'reversed';
  search?: string;
  limit?: number;
}

export async function listDocuments(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: ListDocumentsQuery = {},
): Promise<DocumentRecord[]> {
  let builder = db
    .selectFrom('inventory_documents')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.kind) builder = builder.where('kind', '=', query.kind);
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(eb.fn('lower', ['document_number']), 'like', term),
      eb(eb.fn('lower', ['reference']), 'like', term),
      eb(eb.fn('lower', ['memo']), 'like', term),
    ]));
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await builder
    .orderBy('posting_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const movements = await db
    .selectFrom('inventory_movements')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('document_id', 'in', ids)
    .orderBy('line_number', 'asc')
    .execute();

  const byDocument = new Map<string, MovementRecord[]>();
  for (const movement of movements) {
    const list = byDocument.get(movement.document_id) ?? [];
    list.push(hydrateMovement(movement));
    byDocument.set(movement.document_id, list);
  }
  return rows.map((row) => hydrateDocument(row, byDocument.get(row.id) ?? []));
}

/* ── Supporting reads ──────────────────────────────────────────────────────── */

async function companyDecimals(
  db: Kysely<Database> | Transaction<Database>,
  actor: InventoryActor,
): Promise<number> {
  const org = await db
    .selectFrom('organizations')
    .select('base_currency')
    .where('id', '=', actor.organizationId)
    .executeTakeFirst();
  return monetaryDecimalsFor(org?.base_currency);
}

interface ProfileAccounts {
  inventory: string | null;
  grni: string | null;
  gain: string | null;
  loss: string | null;
}

async function profileOf(
  trx: Transaction<Database>,
  actor: InventoryActor,
): Promise<ProfileAccounts> {
  const row = await trx
    .selectFrom('inventory_settings')
    .select([
      'default_inventory_account_id', 'goods_received_not_invoiced_account_id',
      'inventory_gain_account_id', 'inventory_loss_account_id',
    ])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return {
    inventory: row?.default_inventory_account_id ?? null,
    grni: row?.goods_received_not_invoiced_account_id ?? null,
    gain: row?.inventory_gain_account_id ?? null,
    loss: row?.inventory_loss_account_id ?? null,
  };
}

/**
 * An account that may receive this posting, or a refusal naming the reason.
 *
 * Every account is re-checked at posting time even though I1 checked it when it
 * was mapped: an account can be archived or blocked between the two, and the
 * moment that matters is the moment the entry is written.
 */
async function assertEligible(
  trx: Transaction<Database>,
  actor: InventoryActor,
  accountId: string | null,
  role: string,
  requiredType: string | null,
): Promise<string> {
  if (!accountId) {
    throw errors.validation(
      `This company has no ${role} account configured, so the posting has nowhere to go. `
      + 'Set it on the inventory accounting profile before recording stock.',
      { fieldErrors: { [role]: `Configure the ${role} account first.` } },
    );
  }
  const account = await trx
    .selectFrom('accounts')
    .select([
      'id', 'account_code', 'account_name', 'account_type', 'cash_classification',
      'is_postable', 'active', 'blocked', 'archived',
    ])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();

  if (!account) {
    throw errors.validation(`The ${role} account is not in this company's chart of accounts.`);
  }
  if (requiredType && account.account_type !== requiredType) {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) is ${account.account_type}, and the ${role} `
      + `account must be ${requiredType}.`,
    );
  }
  if (account.cash_classification && account.cash_classification !== 'none') {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) is a cash or bank account and cannot carry `
      + `stock ${role}. Stock is not money.`,
    );
  }
  const children = await trx
    .selectFrom('accounts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('parent_account_id', '=', accountId)
    .executeTakeFirst();
  const verdict = assessPostingAccount(
    {
      archived: account.archived, blocked: account.blocked,
      active: account.active, isPostable: account.is_postable,
    },
    Number(children?.n ?? '0') > 0,
  );
  if (!verdict.eligible) {
    throw errors.validation(
      `${account.account_code} (${account.account_name}) cannot receive this posting. ${verdict.message}`,
    );
  }
  return accountId;
}

interface ResolvedItem {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  unitDecimals: number;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
}

/** The item, if it is one this slice may move at all. */
async function resolveItem(
  trx: Transaction<Database>,
  actor: InventoryActor,
  itemId: string,
): Promise<ResolvedItem> {
  const row = await trx
    .selectFrom('inventory_items as i')
    .innerJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'i.base_unit_id')
      .onRef('u.organization_id', '=', 'i.organization_id')
      .onRef('u.company_id', '=', 'i.company_id'))
    .select([
      'i.id', 'i.item_code', 'i.name', 'i.status', 'i.is_inventory_tracked', 'i.item_type',
      'i.valuation_method', 'i.base_unit_id', 'i.inventory_account_id', 'i.cogs_account_id',
      'u.code as unit_code', 'u.decimal_places as unit_decimals',
    ])
    .where('i.organization_id', '=', actor.organizationId)
    .where('i.company_id', '=', actor.companyId)
    .where('i.id', '=', itemId)
    .executeTakeFirst();

  if (!row) {
    throw errors.validation('That item is not in this company\'s catalogue.', {
      fieldErrors: { itemId: 'Choose an item from this company.' },
    });
  }
  if (row.status !== 'active') {
    throw errors.validation(
      `Item ${row.item_code} is ${row.status} and cannot move stock. Reactivate it first.`,
    );
  }
  if (!row.is_inventory_tracked) {
    throw errors.validation(
      `Item ${row.item_code} is not stock-tracked, so it has no quantity to move. `
      + `A ${row.item_type} item is bought and sold without a warehouse behind it.`,
    );
  }
  if (row.valuation_method !== SUPPORTED_VALUATION) {
    throw errors.validation(UNSUPPORTED_VALUATION(row.valuation_method, row.item_code));
  }

  return {
    id: row.id,
    code: row.item_code,
    name: row.name,
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.unit_code,
    unitDecimals: Number(row.unit_decimals ?? 0),
    inventoryAccountId: row.inventory_account_id ?? null,
    cogsAccountId: row.cogs_account_id ?? null,
  };
}

async function resolveWarehouse(
  trx: Transaction<Database>,
  actor: InventoryActor,
  warehouseId: string | undefined,
  field: string,
): Promise<{ id: string; code: string }> {
  if (!warehouseId) {
    throw errors.validation('A warehouse is required.', {
      fieldErrors: { [field]: 'Choose a warehouse.' },
    });
  }
  const row = await trx
    .selectFrom('warehouses')
    .select(['id', 'code', 'status'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', warehouseId)
    .executeTakeFirst();
  if (!row) {
    throw errors.validation('That warehouse is not in these books.', {
      fieldErrors: { [field]: 'Choose a warehouse from this company.' },
    });
  }
  if (row.status !== 'active') {
    throw errors.validation(`Warehouse ${row.code} is ${row.status} and cannot hold stock movements.`);
  }
  return { id: row.id, code: row.code };
}

/* ── Numbering ─────────────────────────────────────────────────────────────── */

const PREFIX: Record<DocumentKind, string> = {
  receipt: 'GRN-', issue: 'GIN-', transfer: 'TRF-', adjustment: 'ADJ-',
};

async function allocateNumber(
  trx: Transaction<Database>,
  actor: InventoryActor,
  kind: DocumentKind,
  postingDate: string,
): Promise<string> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtext(${`inv_doc_number:${actor.organizationId}:${actor.companyId}:${kind}`}))
  `.execute(trx);

  const existing = await trx
    .selectFrom('inventory_document_numbering')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('kind', '=', kind)
    .executeTakeFirst();

  const config = existing ?? {
    prefix: PREFIX[kind], include_year: true, sequence_length: 4, next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('inventory_document_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      kind,
      prefix: PREFIX[kind],
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('inventory_document_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('kind', '=', kind)
      .execute();
  }

  const year = config.include_year ? `${postingDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/* ── Posting ───────────────────────────────────────────────────────────────── */

interface PlannedMovement {
  lineNumber: number;
  movementType: string;
  item: ResolvedItem;
  warehouseId: string;
  warehouseCode: string;
  direction: 'in' | 'out';
  quantity: Money.Amount;
  unitCost: Money.Amount;
  totalCost: Money.Amount;
  inventoryAccountId: string;
  offsetAccountId: string | null;
}

const accountingActorOf = (actor: InventoryActor): AccountingActor => ({
  organizationId: actor.organizationId,
  companyId: actor.companyId,
  userId: actor.userId,
  name: actor.name,
  requestId: actor.requestId,
});

/** The document this key already made, or null. */
async function findByKey(
  db: Kysely<Database> | Transaction<Database>,
  actor: InventoryActor,
  idempotencyKey: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('inventory_documents')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row?.id ?? null;
}

function isDuplicateKey(cause: unknown): boolean {
  const code = (cause as { code?: string })?.code;
  const message = String((cause as { message?: string })?.message ?? '');
  return code === '23505' || /inventory_documents_idempotency_uidx|duplicate key/i.test(message);
}

export async function postDocument(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: PostDocumentInput,
): Promise<{ document: DocumentRecord; created: boolean }> {
  if (!input.idempotencyKey?.trim()) {
    throw errors.validation('An idempotency key is required so a retry cannot post twice.');
  }
  if (!input.lines?.length) {
    throw errors.validation('Add at least one line.');
  }
  if (input.kind === 'adjustment' && !input.reason?.trim()) {
    throw errors.validation('An adjustment needs a reason: stock does not change itself.', {
      fieldErrors: { reason: 'Say why the quantity changed.' },
    });
  }

  const existingId = await findByKey(db, actor, input.idempotencyKey);
  if (existingId) return { document: await getDocument(db, actor, existingId), created: false };

  const decimals = await companyDecimals(db, actor);
  const postingDate = input.postingDate ?? input.movementDate;

  const outcome = await db.transaction().execute(async (trx) => {
    /* Re-checked inside the transaction: the window between the read above and
     * here is exactly where a retry lands. */
    const raced = await findByKey(trx, actor, input.idempotencyKey);
    if (raced) return { id: raced, created: false };

    /*
     * Locks first, in item order, before anything is read for costing. Sorting
     * is what stops two opposing transfers deadlocking; taking them before the
     * reads is what stops two issues both seeing stock that only one can have.
     */
    await lockItems(trx, actor, input.lines.map((line) => line.itemId));

    /* The period gate, explicitly — a transfer posts no journal, so it would
     * otherwise never meet the check that `postSourceJournalIn` performs. */
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, postingDate, 'post');

    const profile = await profileOf(trx, actor);
    const planned: PlannedMovement[] = [];

    /* Running positions, advanced line by line so a multi-line document is
     * internally consistent: two issues of the same item cost the second at
     * what the first left behind. */
    const positions = new Map<string, Position>();
    const onHand = new Map<string, Money.Amount>();

    const positionFor = async (itemId: string): Promise<Position> => {
      if (!positions.has(itemId)) positions.set(itemId, await positionOf(trx, actor, itemId));
      return positions.get(itemId)!;
    };
    const onHandFor = async (itemId: string, warehouseId: string): Promise<Money.Amount> => {
      const key = `${itemId}:${warehouseId}`;
      if (!onHand.has(key)) onHand.set(key, await onHandAt(trx, actor, itemId, warehouseId));
      return onHand.get(key)!;
    };

    const source = input.kind === 'transfer'
      ? await resolveWarehouse(trx, actor, input.sourceWarehouseId, 'sourceWarehouseId')
      : null;
    const destination = input.kind === 'transfer'
      ? await resolveWarehouse(trx, actor, input.destinationWarehouseId, 'destinationWarehouseId')
      : null;
    if (source && destination && source.id === destination.id) {
      throw errors.validation('A transfer must move stock between two different warehouses.');
    }

    let lineNumber = 0;

    for (const line of input.lines) {
      const item = await resolveItem(trx, actor, line.itemId);
      const quantity = toQuantity(line.quantity, item.unitDecimals, 'quantity');

      /* Backdating: refused behind this item's own history. */
      const latest = await latestPostingDate(trx, actor, item.id);
      if (latest && postingDate < latest) {
        throw errors.validation(
          `${BACKDATING_REFUSED} Item ${item.code} already has a movement posted on ${latest}.`,
          { fieldErrors: { postingDate: `On or after ${latest}.` } },
        );
      }

      const inventoryAccountId = await assertEligible(
        trx, actor, item.inventoryAccountId ?? profile.inventory, 'inventory', 'asset',
      );

      const apply = async (
        direction: 'in' | 'out',
        movementType: string,
        warehouse: { id: string; code: string },
        unitCostInput: Money.Amount | null,
        offsetAccountId: string | null,
      ): Promise<void> => {
        const position = await positionFor(item.id);
        const key = `${item.id}:${warehouse.id}`;
        const available = await onHandFor(item.id, warehouse.id);

        let unitCost: Money.Amount;
        let totalCost: Money.Amount;

        if (direction === 'in') {
          unitCost = unitCostInput ?? Money.ZERO;
          totalCost = inboundCost(quantity, unitCost, decimals);
          positions.set(item.id, {
            quantity: position.quantity + quantity,
            value: position.value + totalCost,
          });
          onHand.set(key, available + quantity);
        } else {
          if (available < quantity) {
            throw errors.validation(
              `${NEGATIVE_STOCK_REFUSED} ${item.code} has ${Money.describe(available)} in `
              + `${warehouse.code} and this would take ${Money.describe(quantity)}.`,
              { fieldErrors: { quantity: `At most ${Money.describe(available)} available.` } },
            );
          }
          /* The cost is the SERVER's: a client-supplied figure for an outbound
           * would be the caller choosing its own cost of sales. */
          totalCost = outboundCost(position, quantity, decimals);
          unitCost = quantity === 0n ? Money.ZERO
            : (totalCost * 10n ** BigInt(Money.SCALE)) / quantity;
          positions.set(item.id, {
            quantity: position.quantity - quantity,
            value: position.value - totalCost,
          });
          onHand.set(key, available - quantity);
        }

        lineNumber += 1;
        planned.push({
          lineNumber,
          movementType,
          item,
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          direction,
          quantity,
          unitCost,
          totalCost,
          inventoryAccountId,
          offsetAccountId,
        });
      };

      if (input.kind === 'receipt') {
        const warehouse = await resolveWarehouse(trx, actor, line.warehouseId, 'warehouseId');
        const unitCost = toUnitCost(line.unitCost, decimals, 'unitCost');
        /*
         * The offset is the goods-received-not-invoiced account and nothing
         * else. The browser falls back to Trade Payables when it is unset,
         * which would create a payable owed to nobody; there is no fallback
         * here at all.
         */
        const grni = await assertEligible(trx, actor, profile.grni, 'goods-received-not-invoiced', null);
        await apply('in', 'receipt', warehouse, unitCost, grni);
      } else if (input.kind === 'issue') {
        const warehouse = await resolveWarehouse(trx, actor, line.warehouseId, 'warehouseId');
        const expense = await assertEligible(
          trx, actor, line.expenseAccountId ?? profile.loss, 'issue expense', 'expense',
        );
        await apply('out', 'issue', warehouse, null, expense);
      } else if (input.kind === 'transfer') {
        /* Two legs, same cost, one act. The out is costed first so the in
         * carries exactly what left — which is what makes it value-neutral. */
        await apply('out', 'transfer-out', source!, null, null);
        const justPlanned = planned[planned.length - 1]!;
        const position = await positionFor(item.id);
        positions.set(item.id, {
          quantity: position.quantity + quantity,
          value: position.value + justPlanned.totalCost,
        });
        const destinationKey = `${item.id}:${destination!.id}`;
        onHand.set(destinationKey, (await onHandFor(item.id, destination!.id)) + quantity);
        lineNumber += 1;
        planned.push({
          lineNumber,
          movementType: 'transfer-in',
          item,
          warehouseId: destination!.id,
          warehouseCode: destination!.code,
          direction: 'in',
          quantity,
          unitCost: justPlanned.unitCost,
          totalCost: justPlanned.totalCost,
          inventoryAccountId,
          offsetAccountId: null,
        });
      } else {
        const warehouse = await resolveWarehouse(trx, actor, line.warehouseId, 'warehouseId');
        if (line.direction !== 'in' && line.direction !== 'out') {
          throw errors.validation('An adjustment line must say whether stock goes in or out.', {
            fieldErrors: { direction: 'Choose in or out.' },
          });
        }
        if (line.direction === 'in') {
          const gain = await assertEligible(trx, actor, profile.gain, 'inventory gain', 'income');
          /* An adjustment in may name its cost; with none, it comes in at what
           * the item is currently worth. */
          const position = await positionFor(item.id);
          const unitCost = line.unitCost === undefined || line.unitCost === null || line.unitCost === ''
            ? (position.quantity === 0n ? Money.ZERO
              : (position.value * 10n ** BigInt(Money.SCALE)) / position.quantity)
            : toUnitCost(line.unitCost, decimals, 'unitCost');
          await apply('in', 'adjustment-in', warehouse, unitCost, gain);
        } else {
          const loss = await assertEligible(trx, actor, profile.loss, 'inventory loss', 'expense');
          await apply('out', 'adjustment-out', warehouse, null, loss);
        }
      }
    }

    const documentNumber = await allocateNumber(trx, actor, input.kind, postingDate);

    let created: { id: string };
    try {
      created = await trx
        .insertInto('inventory_documents')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          document_number: documentNumber,
          kind: input.kind,
          movement_date: input.movementDate,
          posting_date: postingDate,
          reference: input.reference ?? '',
          memo: input.memo ?? '',
          reason: input.reason ?? '',
          idempotency_key: input.idempotencyKey,
          created_by: actor.userId,
          /* Filled in below for everything but a transfer, which posts none. */
          journal_entry_id: null,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (cause) {
      if (isDuplicateKey(cause)) {
        /* Lost the race. Inside a transaction the statement has aborted this
         * one, so the honest move is to let it roll back and answer from the
         * winner on the way out. */
        throw errors.conflict(
          'That posting is already being recorded. Retry in a moment — it will not post twice.',
        );
      }
      throw cause;
    }

    for (const movement of planned) {
      await trx.insertInto('inventory_movements').values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        document_id: created.id,
        line_number: movement.lineNumber,
        movement_type: movement.movementType,
        item_id: movement.item.id,
        warehouse_id: movement.warehouseId,
        base_unit_id: movement.item.baseUnitId,
        direction: movement.direction,
        quantity: Money.toDecimalString(movement.quantity),
        unit_cost: Money.toDecimalString(movement.unitCost),
        total_cost: Money.toDecimalString(movement.totalCost),
        inventory_account_id: movement.inventoryAccountId,
        offset_account_id: movement.offsetAccountId,
        item_code: movement.item.code,
        item_name: movement.item.name,
        warehouse_code: movement.warehouseCode,
        base_unit_code: movement.item.baseUnitCode,
        movement_date: input.movementDate,
        posting_date: postingDate,
        created_by: actor.userId,
      } as never).execute();
    }

    /*
     * A transfer posts no journal. Stock has not changed hands, changed value
     * or changed account — it is in a different building, which the general
     * ledger has no opinion about.
     */
    if (input.kind !== 'transfer') {
      const lines = planned.flatMap((movement) => {
        const amount = Money.toDecimalString(movement.totalCost);
        const label = `${input.kind} — ${movement.item.code}`;
        return movement.direction === 'in'
          ? [
            { accountId: movement.inventoryAccountId, debit: amount, memo: label },
            { accountId: movement.offsetAccountId!, credit: amount, memo: label },
          ]
          : [
            { accountId: movement.offsetAccountId!, debit: amount, memo: label },
            { accountId: movement.inventoryAccountId, credit: amount, memo: label },
          ];
      });

      const { journal } = await postSourceJournalIn(trx, accountingActorOf(actor), {
        sourceType: 'inventory_document',
        sourceId: created.id,
        sourceEvent: 'post',
        transactionDate: input.movementDate,
        postingDate,
        reference: documentNumber,
        description: `${input.kind[0]!.toUpperCase()}${input.kind.slice(1)} ${documentNumber}`,
        lines,
      });

      await trx.updateTable('inventory_documents')
        .set({ journal_entry_id: journal.id } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', created.id)
        .execute();
    }

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: null,
      action: `STOCK_${input.kind.toUpperCase()}_POSTED`,
      resultingVersion: 1,
      detail: { documentId: created.id, documentNumber, lines: planned.length },
    });

    return { id: created.id, created: true };
  });

  return { document: await getDocument(db, actor, outcome.id), created: outcome.created };
}

/* ── Reversal ──────────────────────────────────────────────────────────────── */

export async function reverseDocument(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  reason: string,
): Promise<DocumentRecord> {
  /*
   * Five characters, because the journal service demands that of every
   * withdrawal reason and refusing here says so plainly. Letting it through
   * would surface a message about "the entry's history" to somebody who was
   * reversing a goods receipt and had no idea a journal was involved.
   */
  if ((reason ?? '').trim().length < 5) {
    throw errors.validation(
      'A reason of at least five characters is required, and it is recorded permanently against '
      + 'both the stock document and the journal it withdraws.',
      { fieldErrors: { reason: 'Say why this is being reversed.' } },
    );
  }

  const reversalId = await db.transaction().execute(async (trx) => {
    const original = await trx
      .selectFrom('inventory_documents')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!original) throw errors.notFound('Stock document');
    assertVersion(Number(original.version), expectedVersion);
    if (original.status === 'reversed') {
      throw errors.conflict('That document has already been reversed.');
    }

    const movements = await trx
      .selectFrom('inventory_movements')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('document_id', '=', id)
      .orderBy('line_number', 'asc')
      .execute();

    await lockItems(trx, actor, movements.map((m) => m.item_id));

    const today = new Date().toISOString().slice(0, 10);
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, today, 'post');

    /*
     * Reversing an inbound takes that quantity back out. If it is no longer
     * there, the stock has been consumed and an exact restoration is impossible
     * — the product's answer is a controlled correction, not a reversal that
     * drives a warehouse below zero.
     */
    for (const movement of movements) {
      if (movement.direction !== 'in') continue;
      const available = await onHandAt(trx, actor, movement.item_id, movement.warehouse_id);
      const quantity = Money.toAmount(movement.quantity, 'quantity');
      if (available < quantity) {
        throw errors.validation(
          `Cannot reverse ${original.document_number}: only ${Money.describe(available)} of `
          + `${movement.item_code} remain in ${movement.warehouse_code}, but the document added `
          + `${Money.describe(quantity)}. Some of it has been used, so the reversal cannot restore `
          + 'the position exactly. Record a correcting adjustment instead.',
        );
      }
    }

    const reversalNumber = await allocateNumber(
      trx, actor, original.kind as DocumentKind, today,
    );

    const created = await trx
      .insertInto('inventory_documents')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        document_number: reversalNumber,
        kind: original.kind,
        movement_date: today,
        posting_date: today,
        reference: original.document_number,
        memo: `Reversal of ${original.document_number}`,
        reason: original.kind === 'adjustment' ? reason.trim() : '',
        status: 'reversed',
        idempotency_key: `reverse:${id}`,
        reversal_of_document_id: id,
        reversal_reason: reason.trim(),
        created_by: actor.userId,
        journal_entry_id: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    /*
     * The counter-movements are written already reversed, and the originals are
     * flipped to reversed too. Both sides then fall out of every sum, which is
     * what "exactly restored" means here — a plain opposite movement left in the
     * running average would leave a different average behind, not the original.
     */
    let line = 0;
    for (const movement of movements) {
      line += 1;
      const counter = await trx
        .insertInto('inventory_movements')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          document_id: created.id,
          line_number: line,
          movement_type: OPPOSITE_TYPE[movement.movement_type]
            ?? (movement.direction === 'in' ? 'adjustment-out' : 'adjustment-in'),
          item_id: movement.item_id,
          warehouse_id: movement.warehouse_id,
          base_unit_id: movement.base_unit_id,
          direction: movement.direction === 'in' ? 'out' : 'in',
          quantity: movement.quantity,
          /* The ORIGINAL cost, never today's average. */
          unit_cost: movement.unit_cost,
          total_cost: movement.total_cost,
          inventory_account_id: movement.inventory_account_id,
          offset_account_id: movement.offset_account_id,
          item_code: movement.item_code,
          item_name: movement.item_name,
          warehouse_code: movement.warehouse_code,
          base_unit_code: movement.base_unit_code,
          movement_date: today,
          posting_date: today,
          status: 'reversed',
          reversal_of_movement_id: movement.id,
          created_by: actor.userId,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx.updateTable('inventory_movements')
        .set({ status: 'reversed', reversed_by_movement_id: counter.id } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', movement.id)
        .execute();
    }

    if (original.journal_entry_id) {
      const journal = await trx
        .selectFrom('journal_entries')
        .select(['id', 'version'])
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', original.journal_entry_id)
        .executeTakeFirst();
      if (!journal) throw errors.conflict('The journal behind this document is missing.');

      const { reversal } = await reverseJournalIn(
        trx, accountingActorOf(actor), original.journal_entry_id,
        { expectedVersion: Number(journal.version), reason: reason.trim(), postingDate: today },
      );
      await trx.updateTable('inventory_documents')
        .set({ journal_entry_id: reversal.id } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', created.id)
        .execute();
    }

    await trx.updateTable('inventory_documents')
      .set({
        status: 'reversed',
        reversed_by_document_id: created.id,
        reversal_reason: reason.trim(),
        version: Number(original.version) + 1,
        updated_at: new Date(),
      } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: null,
      action: 'STOCK_DOCUMENT_REVERSED',
      resultingVersion: Number(original.version) + 1,
      detail: { documentId: id, reversalId: created.id, reason: reason.trim() },
    });

    return created.id;
  });

  return getDocument(db, actor, reversalId);
}
