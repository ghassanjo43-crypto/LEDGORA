/**
 * Every customer-management write, in one place.
 *
 * ══ Why a seam rather than a branch per screen ═══════════════════════════════
 *
 * Four components mutate customers: the directory, the form drawer, the table's
 * row actions and the quick-create dialog. If each decided for itself whether
 * the server owns this workspace, the one that was forgotten would keep writing
 * to `localStorage` for a paying subscriber — which is the exact failure S1
 * exists to close, reintroduced by omission. So the decision lives here and the
 * screens ask.
 *
 * ══ What crosses the boundary, and what cannot ═══════════════════════════════
 *
 * `toCustomerWriteInput` copies the shared identity fields and the customer
 * profile. It does not copy `supplierCategory`, `defaultExpenseAccount`,
 * `defaultPayableAccount`, `supplierPaymentTerms`, `withholdingTaxApplicable` or
 * `preferredPaymentMethod` — not because it is careful, but because they are not
 * in the object it builds. A customer screen therefore cannot modify a
 * supplier-only field even if a form is later given one by mistake.
 *
 * ══ Two actions have no server equivalent in S1 ══════════════════════════════
 *
 * Changing which ROLES a party holds, and importing a file of parties. Both are
 * refused in durable mode with a message saying so. Falling back to the local
 * store for either would write a durable subscriber's directory into the
 * browser, which is precisely what this slice removed.
 */
import type { EntityFormValues } from '@/lib/entityValidation';
import type { CustomerWriteInput, ServerBusinessParty } from '@/services/api/customersApi';
import { useEntityStore } from '@/store/useEntityStore';
import {
  customerGateway,
  customersAreServerAuthoritative,
  useCustomerDirectory,
} from './customerDirectory';

export interface CustomerActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** True when the server refused because somebody else edited first. */
  conflict?: boolean;
}

/**
 * A form's credit limit as a decimal string.
 *
 * The form field is a `number`, so this is the last point at which the value is
 * one. `toFixed` rather than `String`, because `String(1e21)` is `"1e+21"` and
 * PostgreSQL would reject it — an amount nobody can enter by hand, but a
 * paste can.
 */
function creditLimitString(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '0';
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Form values as the server's customer payload.
 *
 * The single flattened address the form collects becomes the PRIMARY billing
 * address. The server models several addresses with purposes; this screen
 * offers one, so it fills one and leaves the rest to a later slice rather than
 * inventing shipping details nobody typed.
 */
export function toCustomerWriteInput(values: EntityFormValues): CustomerWriteInput {
  const hasAddress = Boolean(
    values.addressLine1 || values.addressLine2 || values.city || values.postalCode || values.country,
  );

  return {
    partyCode: values.entityCode,
    legalName: values.legalName,
    tradingName: values.tradingName,
    contactPerson: values.contactPerson,
    jobTitle: values.jobTitle,
    email: values.email,
    phone: values.phone,
    mobile: values.mobile,
    website: values.website,
    taxRegistrationNumber: values.taxRegistrationNumber,
    commercialRegistrationNumber: values.commercialRegistrationNumber,
    paymentTerms: values.paymentTerms,
    defaultCurrency: values.defaultCurrency,
    bankName: values.bankName,
    bankAccountName: values.bankAccountName,
    iban: values.iban,
    swiftCode: values.swiftCode,
    notes: values.notes,
    addresses: hasAddress
      ? [{
          purpose: 'billing',
          isPrimary: true,
          addressLine1: values.addressLine1,
          addressLine2: values.addressLine2,
          city: values.city,
          postalCode: values.postalCode,
          country: values.country,
        }]
      : [],
    customer: {
      customerCategory: values.customerCategory,
      creditLimit: creditLimitString(values.creditLimit),
      defaultRevenueAccountId: values.defaultRevenueAccount || null,
      defaultReceivableAccountId: values.defaultReceivableAccount || null,
      defaultInvoiceTemplateId: values.defaultInvoiceTemplateId || null,
      invoiceDeliveryMethod: values.invoiceDeliveryMethod,
      customerPaymentTerms: values.customerPaymentTerms,
    },
  };
}

/** The server party behind a mapped row, for its version. */
function partyById(id: string): ServerBusinessParty | undefined {
  return useCustomerDirectory.getState().customers.find((p) => p.id === id);
}

const GONE = 'That customer is no longer in the directory. Reload and try again.';

/**
 * Turn a rejected request into something a person can act on.
 *
 * A version conflict is flagged separately because the screen's response is
 * different: not "try again" but "look at what changed first". Everything else
 * keeps the server's own words — a permission refusal and a subscription
 * refusal say different things and a generic message would hide which.
 */
function asResult(cause: unknown): CustomerActionResult {
  const message = cause instanceof Error ? cause.message : 'Could not save this customer.';
  return { ok: false, error: message, conflict: /changed by someone else/i.test(message) };
}

export const ROLE_CHANGE_UNSUPPORTED =
  'Changing which roles a party holds is not available for server-held customers yet. '
  + 'The supplier side of the directory has not moved to the server.';

export const IMPORT_UNSUPPORTED =
  'Importing a file of parties is not available for server-held customers. '
  + 'Add them individually, or import while using a demo workspace.';

export interface CustomerActions {
  /** True when these actions go to the server. */
  serverBacked: boolean;
  save: (values: EntityFormValues, editingId?: string) => Promise<CustomerActionResult>;
  setArchived: (id: string, archived: boolean) => Promise<CustomerActionResult>;
  duplicate: (id: string) => Promise<CustomerActionResult>;
  /** False in durable mode: no server operation exists. See the constants. */
  canChangeRoles: boolean;
  canImport: boolean;
}

export function customerActions(): CustomerActions {
  const serverBacked = customersAreServerAuthoritative();

  if (!serverBacked) {
    /* Free Demo: the local store, exactly as before this slice. */
    const store = useEntityStore.getState();
    return {
      serverBacked: false,
      save: async (values, editingId) =>
        (editingId ? store.updateEntity(editingId, values) : store.addEntity(values)),
      setArchived: async (id, archived) => {
        store.setActive(id, !archived);
        return { ok: true, id };
      },
      duplicate: async (id) => store.duplicateEntity(id),
      canChangeRoles: true,
      canImport: true,
    };
  }

  return {
    serverBacked: true,

    save: async (values, editingId) => {
      const input = toCustomerWriteInput(values);
      try {
        if (!editingId) {
          const created = await customerGateway.create(input);
          return { ok: true, id: created.id };
        }
        /*
         * The version comes from the cached server row, not from the form. A
         * form that carried its own version would send back whatever it was
         * opened with even after the screen had been refreshed underneath it.
         */
        const current = partyById(editingId);
        if (!current) return { ok: false, error: GONE };
        const updated = await customerGateway.update(editingId, {
          ...input,
          expectedVersion: current.version,
        });
        return { ok: true, id: updated.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    setArchived: async (id, archived) => {
      const current = partyById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        await customerGateway.setArchived(id, { archived, expectedVersion: current.version });
        return { ok: true, id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    /*
     * Duplicating is a CREATE of a new party from an existing one's fields, so
     * it goes through the same door and gets the same uniqueness enforcement. A
     * derived code that is already taken comes back as the server's conflict
     * rather than being silently suffixed again — the person is choosing a
     * code, and should see that.
     */
    duplicate: async (id) => {
      const source = partyById(id);
      if (!source) return { ok: false, error: GONE };

      const taken = new Set(
        useCustomerDirectory.getState().customers.map((p) => p.partyCode.trim().toLowerCase()),
      );
      let candidate = `${source.partyCode}-COPY`;
      for (let n = 2; taken.has(candidate.trim().toLowerCase()) && n < 1000; n += 1) {
        candidate = `${source.partyCode}-COPY${n}`;
      }

      try {
        const created = await customerGateway.create({
          partyCode: candidate,
          legalName: `${source.legalName} (copy)`,
          tradingName: source.tradingName,
          contactPerson: source.contactPerson,
          jobTitle: source.jobTitle,
          email: source.email,
          phone: source.phone,
          mobile: source.mobile,
          website: source.website,
          /* Never copied: it is unique, and a copy is a different party. */
          taxRegistrationNumber: '',
          commercialRegistrationNumber: source.commercialRegistrationNumber,
          paymentTerms: source.paymentTerms,
          defaultCurrency: source.defaultCurrency,
          bankName: source.bankName,
          bankAccountName: source.bankAccountName,
          iban: source.iban,
          swiftCode: source.swiftCode,
          notes: source.notes,
          addresses: source.addresses.map((a) => ({
            purpose: a.purpose,
            isPrimary: a.isPrimary,
            addressLine1: a.addressLine1,
            addressLine2: a.addressLine2,
            city: a.city,
            postalCode: a.postalCode,
            country: a.country,
          })),
          customer: source.customer ?? undefined,
        });
        return { ok: true, id: created.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    canChangeRoles: false,
    canImport: false,
  };
}
