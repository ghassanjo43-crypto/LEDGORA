/**
 * Phase A1 — the accounting foundation.
 *
 * ══ What changes, and why it has to be here ══════════════════════════════════
 *
 * Ledgora's platform data (users, organizations, subscriptions) has always been
 * in PostgreSQL; the BOOKS have not. Journals, invoices and balances lived in
 * each user's browser under `localStorage`, which means the accounting records
 * were per-device, unshareable between two people in the same company, and
 * destroyable by clearing site data. Every rule the application enforced about
 * them — permissions, period locks, concurrency — was enforced in code the
 * account holder could edit. This migration begins moving the books to the one
 * place those guarantees can actually hold.
 *
 * ══ Scope of this migration ══════════════════════════════════════════════════
 *
 * Accounts, accounting periods, journal entries and journal lines, plus the
 * append-only version and audit tables that make a correction reconstructable.
 * Receivables, payables and reporting arrive in later milestones and are
 * deliberately absent here rather than stubbed.
 *
 * ══ Two conventions this file commits to ═════════════════════════════════════
 *
 * TENANCY. Every table carries `organization_id` and cascades from
 * `organizations`. A journal line carries it too, denormalised from its entry:
 * the ledger reads lines directly, and a tenant filter that has to join through
 * the parent to be correct is a tenant filter somebody will eventually forget.
 * The redundancy is held true by a composite foreign key, so a line cannot
 * belong to one organization and its entry to another.
 *
 * MONEY. `numeric` throughout, never `double precision`. Scale 10 rather than
 * 2, because minor units are a property of the CURRENCY: JOD and KWD have
 * three, and a rate-converted functional amount needs more headroom than the
 * currency it came from.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

/*
 * Money is written as a literal `numeric(28,10)` in the DDL below rather than
 * interpolated from a shared fragment: a Kysely `sql` fragment composes as a
 * VALUE, and a column type is not a value — PostgreSQL rejects the placeholder.
 * Exact decimal, never floating point. Scale 10 because minor units belong to
 * the currency (JOD and KWD have three) and a converted functional amount needs
 * more headroom than the currency it came from.
 */

export async function up(db: AnyKysely): Promise<void> {
  /* ══ Accounting periods ═══════════════════════════════════════════════════
   *
   * The lock that makes "the books are closed" mean something. A period is the
   * unit posting is allowed or refused against, so it is created before the
   * tables that reference it.
   *
   * Overlap is prevented by `(organization_id, fiscal_year, period_number)`
   * plus an application check, deliberately NOT by an exclusion constraint:
   * `EXCLUDE USING gist` needs the `btree_gist` extension, which is not
   * available on every engine this schema has to run against (the test suite
   * runs PGlite). The unique key stops the ordinary mistake — the same period
   * twice — and `periodService` refuses a genuinely overlapping date range.
   */
  await sql`
    CREATE TABLE accounting_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

      fiscal_year integer NOT NULL,
      period_number integer NOT NULL CHECK (period_number BETWEEN 1 AND 13),
      start_date date NOT NULL,
      end_date date NOT NULL,

      /*
       * open        — posting and amendment permitted
       * soft_closed — posting refused, an authorised correction still allowed
       * locked      — nothing may change without an audited reopen
       */
      status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','soft_closed','locked')),

      locked_at timestamptz,
      locked_by uuid REFERENCES users(id) ON DELETE SET NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT accounting_periods_range CHECK (end_date >= start_date),
      CONSTRAINT accounting_periods_unique UNIQUE (organization_id, fiscal_year, period_number)
    )
  `.execute(db);

  await sql`
    CREATE INDEX accounting_periods_lookup_idx
      ON accounting_periods (organization_id, start_date, end_date)
  `.execute(db);

  /* ══ Chart of accounts ════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

      account_code text NOT NULL,
      account_name text NOT NULL,
      account_type text NOT NULL
        CHECK (account_type IN ('asset','liability','equity','income','expense')),
      account_subtype text,

      normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit')),

      /*
       * Self-referencing, and scoped: the composite target guarantees a parent
       * belongs to the SAME organization. A plain 'REFERENCES accounts(id)'
       * would happily let one tenant's account be re-parented under another's.
       */
      parent_account_id uuid,

      /** '' or NULL means the account accepts any currency. */
      restricted_currency text,

      /** Header accounts organise; only postable accounts receive lines. */
      is_postable boolean NOT NULL DEFAULT true,
      active boolean NOT NULL DEFAULT true,
      /** Created by Ledgora (AR control, retained earnings…). Never deleted. */
      system_account boolean NOT NULL DEFAULT false,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT accounts_code_unique UNIQUE (organization_id, account_code),
      /* The target a scoped child FK can point at. */
      CONSTRAINT accounts_org_id_unique UNIQUE (organization_id, id)
    )
  `.execute(db);

  await sql`
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_parent_same_org
      FOREIGN KEY (organization_id, parent_account_id)
      REFERENCES accounts (organization_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`CREATE INDEX accounts_org_active_idx ON accounts (organization_id, active)`.execute(db);

  /* ══ Journal entries ══════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE journal_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

      /*
       * Human reference, scoped to the tenant. Never global: two organizations
       * both having a JE-0001 is correct, and a globally unique sequence would
       * leak how many entries every other tenant has written.
       */
      journal_number text NOT NULL,
      journal_type text NOT NULL DEFAULT 'general',

      /** When it happened, and which period it lands in. */
      transaction_date date NOT NULL,
      posting_date date NOT NULL,

      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','posted','reversed','voided')),

      reference text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      notes text NOT NULL DEFAULT '',

      /*
       * Both currencies are recorded on every entry. The functional currency is
       * copied from the organization AT POSTING TIME and never re-derived: a
       * company that later changes its functional currency must not silently
       * restate what it already posted.
       */
      transaction_currency text NOT NULL,
      functional_currency text NOT NULL,
      exchange_rate numeric(28,10) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),

      /** Which document produced this entry, when another module owns it. */
      source_type text,
      source_id uuid,

      /* Correction lineage. All three are plain uuids by design — see below. */
      original_entry_id uuid,
      reversal_entry_id uuid,
      replacement_entry_id uuid,

      /** Optimistic concurrency token. Every mutation increments it. */
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),

      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      posted_by uuid REFERENCES users(id) ON DELETE SET NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      posted_at timestamptz,

      CONSTRAINT journal_entries_number_unique UNIQUE (organization_id, journal_number),
      CONSTRAINT journal_entries_org_id_unique UNIQUE (organization_id, id),
      /* A posted entry must say who posted it and when. */
      CONSTRAINT journal_entries_posted_complete CHECK (
        status <> 'posted' OR (posted_at IS NOT NULL)
      )
    )
  `.execute(db);

  /*
   * The correction links are scoped foreign keys added after the table exists,
   * because they point back into it. ON DELETE RESTRICT: a posted entry that
   * something else corrects is evidence, and evidence does not disappear
   * because its counterpart was removed.
   */
  for (const column of ['original_entry_id', 'reversal_entry_id', 'replacement_entry_id'] as const) {
    await sql.raw(
      `ALTER TABLE journal_entries
         ADD CONSTRAINT journal_entries_${column}_same_org
         FOREIGN KEY (organization_id, ${column})
         REFERENCES journal_entries (organization_id, id) ON DELETE RESTRICT`,
    ).execute(db);
  }

  await sql`
    CREATE INDEX journal_entries_posting_idx
      ON journal_entries (organization_id, status, posting_date)
  `.execute(db);
  await sql`
    CREATE INDEX journal_entries_source_idx
      ON journal_entries (organization_id, source_type, source_id)
      WHERE source_type IS NOT NULL
  `.execute(db);

  /* ══ Journal lines ════════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE journal_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      journal_entry_id uuid NOT NULL,

      line_number integer NOT NULL CHECK (line_number >= 1),

      account_id uuid NOT NULL,

      /*
       * Dimensions are IDs, never display names. A name is a label that can be
       * edited afterwards; the ledger needs the thing itself. They are nullable
       * because a line legitimately has no entity, project or cost center.
       *
       * These are NOT foreign keys yet: entities, projects and cost centers are
       * still browser-resident and arrive in milestones A4 and A8. The
       * application validates that a supplied id belongs to this organization,
       * and the constraint is added when the referenced table exists — an FK to
       * a table that does not exist is not a constraint, it is a migration
       * failure.
       */
      entity_id uuid,
      project_id uuid,
      cost_center_id uuid,

      memo text NOT NULL DEFAULT '',

      /* Amounts as entered, in the transaction's own currency. */
      debit_transaction numeric(28,10) NOT NULL DEFAULT 0 CHECK (debit_transaction >= 0),
      credit_transaction numeric(28,10) NOT NULL DEFAULT 0 CHECK (credit_transaction >= 0),
      /* The same amounts translated into the books' functional currency. */
      debit_functional numeric(28,10) NOT NULL DEFAULT 0 CHECK (debit_functional >= 0),
      credit_functional numeric(28,10) NOT NULL DEFAULT 0 CHECK (credit_functional >= 0),

      exchange_rate numeric(28,10) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      /*
       * The oldest rule in double-entry bookkeeping, written where it cannot be
       * bypassed: a line is a debit or a credit, never both. Enforced in the
       * DATABASE and not only in the service, because "no caller currently does
       * that" is exactly the guarantee that decays.
       */
      CONSTRAINT journal_lines_debit_xor_credit CHECK (
        (debit_transaction > 0 AND credit_transaction = 0)
        OR (credit_transaction > 0 AND debit_transaction = 0)
        OR (debit_transaction = 0 AND credit_transaction = 0)
      ),
      /* The functional side must agree with the transaction side about which it is. */
      CONSTRAINT journal_lines_functional_side CHECK (
        (debit_transaction > 0) = (debit_functional > 0)
        AND (credit_transaction > 0) = (credit_functional > 0)
      ),
      CONSTRAINT journal_lines_number_unique UNIQUE (journal_entry_id, line_number)
    )
  `.execute(db);

  /* Composite FKs: a line, its entry and its account are one organization's. */
  await sql`
    ALTER TABLE journal_lines
      ADD CONSTRAINT journal_lines_entry_same_org
      FOREIGN KEY (organization_id, journal_entry_id)
      REFERENCES journal_entries (organization_id, id) ON DELETE CASCADE
  `.execute(db);
  await sql`
    ALTER TABLE journal_lines
      ADD CONSTRAINT journal_lines_account_same_org
      FOREIGN KEY (organization_id, account_id)
      REFERENCES accounts (organization_id, id) ON DELETE RESTRICT
  `.execute(db);

  /* The General Ledger reads these three ways; each gets an index. */
  await sql`
    CREATE INDEX journal_lines_account_idx ON journal_lines (organization_id, account_id)
  `.execute(db);
  await sql`
    CREATE INDEX journal_lines_entry_idx ON journal_lines (journal_entry_id, line_number)
  `.execute(db);
  await sql`
    CREATE INDEX journal_lines_entity_idx ON journal_lines (organization_id, entity_id)
      WHERE entity_id IS NOT NULL
  `.execute(db);

  /* ══ Immutable version history ════════════════════════════════════════════
   *
   * A full snapshot of the entry and its lines as they stood BEFORE a change,
   * stored as jsonb. Not a diff: a diff is only meaningful against a chain of
   * every earlier diff, and the question an auditor asks is "what did this say
   * at the time", which a snapshot answers on its own.
   */
  await sql`
    CREATE TABLE journal_entry_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      journal_entry_id uuid NOT NULL,

      version integer NOT NULL CHECK (version >= 1),
      /* created | posted | amended | reversed | replaced | voided */
      change_kind text NOT NULL,
      /* Mandatory for a correction to a posted entry; '' for creation. */
      reason text NOT NULL DEFAULT '',

      snapshot jsonb NOT NULL,
      changes jsonb NOT NULL DEFAULT '[]'::jsonb,

      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_name text NOT NULL DEFAULT '',
      at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT journal_entry_versions_unique UNIQUE (journal_entry_id, version)
    )
  `.execute(db);

  await sql`
    ALTER TABLE journal_entry_versions
      ADD CONSTRAINT journal_entry_versions_entry_same_org
      FOREIGN KEY (organization_id, journal_entry_id)
      REFERENCES journal_entries (organization_id, id) ON DELETE CASCADE
  `.execute(db);

  /* ══ Accounting audit events ══════════════════════════════════════════════
   *
   * Append-only, and deliberately NOT the platform `audit_logs` table: that one
   * records administrative acts on tenants, this one records acts on the books.
   * Keeping them apart means a tenant-administration purge can never take the
   * accounting trail with it.
   *
   * No foreign key to the record it describes: the event has to outlive a draft
   * that was deleted, and "who deleted the draft" is precisely what this exists
   * to answer.
   */
  await sql`
    CREATE TABLE accounting_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

      /* JOURNAL_POSTED, PERIOD_LOCKED, INVOICE_ISSUED … */
      action text NOT NULL,
      record_type text NOT NULL,
      record_id uuid,

      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_name text NOT NULL DEFAULT '',
      reason text NOT NULL DEFAULT '',

      previous_version integer,
      resulting_version integer,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,

      request_id text,
      at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX accounting_audit_events_record_idx
      ON accounting_audit_events (organization_id, record_type, record_id, at)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  // Children before parents; the composite FKs make the order load-bearing.
  await sql`DROP TABLE IF EXISTS accounting_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_entry_versions`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS journal_entries`.execute(db);
  await sql`DROP TABLE IF EXISTS accounts`.execute(db);
  await sql`DROP TABLE IF EXISTS accounting_periods`.execute(db);
}
