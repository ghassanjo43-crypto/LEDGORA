/**
 * Supplier writes: the server for a durable subscriber, the local store for Free
 * Demo, and never both.
 *
 * ══ Why the supplier screen cannot touch a CUSTOMER field ════════════════════
 *
 * `toSupplierWriteInput` copies the shared identity fields and the supplier
 * profile. It does not copy `customerCategory`, `creditLimit`,
 * `defaultRevenueAccount`, `defaultReceivableAccount`, `defaultInvoiceTemplateId`,
 * `invoiceDeliveryMethod` or `customerPaymentTerms` — not because it is careful,
 * but because they are not in the object it builds. A supplier screen therefore
 * cannot modify a customer-only field even if a form is later given one by
 * mistake. `customerActions` has the mirror of this guarantee.
 *
 * ══ Two actions have no server equivalent in P1 ══════════════════════════════
 *
 * Changing which ROLES a party holds from the ordinary form, and importing a
 * file of parties. Both are refused in durable mode with a message saying so.
 * Falling back to the local store for either would write a durable subscriber's
 * directory into the browser, which is precisely what this slice removes.
 *
 * Granting the supplier role to an EXISTING party does have a server path —
 * `supplierGateway.grantSupplierRole` — because one legal party trading in both
 * directions must stay one record. It is a deliberate, separate action rather
 * than a side effect of saving a form.
 */
import type { EntityFormValues } from '@/lib/entityValidation';
import type { SupplierWriteInput, ServerSupplierParty } from '@/services/api/suppliersApi';
import { useEntityStore } from '@/store/useEntityStore';
import {
  supplierGateway,
  suppliersAreServerAuthoritative,
  useSupplierDirectory,
} from './supplierDirectory';

export interface SupplierActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** True when the server refused because somebody else edited first. */
  conflict?: boolean;
}

export function toSupplierWriteInput(values: EntityFormValues): SupplierWriteInput {
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
          /* The single browser address becomes the primary REMITTANCE address,
           * which is the one a payment run would read. */
          purpose: 'billing',
          isPrimary: true,
          addressLine1: values.addressLine1,
          addressLine2: values.addressLine2,
          city: values.city,
          postalCode: values.postalCode,
          country: values.country,
        }]
      : [],
    supplier: {
      supplierCategory: values.supplierCategory,
      defaultPayableAccountId: values.defaultPayableAccount || null,
      defaultExpenseAccountId: values.defaultExpenseAccount || null,
      supplierPaymentTerms: values.supplierPaymentTerms,
      withholdingTaxApplicable: values.withholdingTaxApplicable,
      preferredPaymentMethod: values.preferredPaymentMethod,
    },
  };
}

/** The server party behind a mapped row, for its version. */
function partyById(id: string): ServerSupplierParty | undefined {
  return useSupplierDirectory.getState().suppliers.find((p) => p.id === id);
}

const GONE = 'That supplier is no longer in the directory. Reload and try again.';

/**
 * The server's own words, kept.
 *
 * A permission refusal and a subscription refusal say different things, and a
 * generic message would hide which.
 */
function asResult(cause: unknown): SupplierActionResult {
  const message = cause instanceof Error ? cause.message : 'Could not save this supplier.';
  return { ok: false, error: message, conflict: /changed by someone else/i.test(message) };
}

export const ROLE_CHANGE_UNSUPPORTED =
  'Changing which roles a party holds is not available from this form for server-held suppliers. '
  + 'Use the customer directory to add the customer role to an existing party.';

export const IMPORT_UNSUPPORTED =
  'Importing a file of parties is not available for server-held suppliers. '
  + 'Add them individually, or import while using a demo workspace.';

export interface SupplierActions {
  /** True when these actions go to the server. */
  serverBacked: boolean;
  save: (values: EntityFormValues, editingId?: string) => Promise<SupplierActionResult>;
  setArchived: (id: string, archived: boolean) => Promise<SupplierActionResult>;
  duplicate: (id: string) => Promise<SupplierActionResult>;
  /** False in durable mode: no server operation exists. See the constants. */
  canChangeRoles: boolean;
  canImport: boolean;
}

export function supplierActions(): SupplierActions {
  const serverBacked = suppliersAreServerAuthoritative();

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
      const input = toSupplierWriteInput(values);
      try {
        if (!editingId) {
          const created = await supplierGateway.create(input);
          return { ok: true, id: created.id };
        }
        /*
         * The version comes from the cached server row, not from the form. A
         * form carrying its own version would send back whatever it opened
         * with, even after the screen had been refreshed underneath it.
         */
        const current = partyById(editingId);
        if (!current) return { ok: false, error: GONE };
        const updated = await supplierGateway.update(editingId, {
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
        await supplierGateway.setArchived(id, { archived, expectedVersion: current.version });
        return { ok: true, id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    /*
     * Duplicating is a CREATE of a new party from an existing one's fields, so
     * it goes through the same door and gets the same uniqueness enforcement.
     * A derived code that is already taken comes back as the server's conflict
     * rather than being silently suffixed again — the person is choosing a
     * code, and should see that.
     */
    duplicate: async (id) => {
      const source = partyById(id);
      if (!source) return { ok: false, error: GONE };

      const taken = new Set(
        useSupplierDirectory.getState().suppliers.map((p) => p.partyCode.trim().toLowerCase()),
      );
      let candidate = `${source.partyCode}-COPY`;
      for (let n = 2; taken.has(candidate.trim().toLowerCase()) && n < 1000; n += 1) {
        candidate = `${source.partyCode}-COPY${n}`;
      }

      try {
        const created = await supplierGateway.create({
          partyCode: candidate,
          legalName: source.legalName,
          tradingName: source.tradingName,
          contactPerson: source.contactPerson,
          jobTitle: source.jobTitle,
          email: source.email,
          phone: source.phone,
          mobile: source.mobile,
          website: source.website,
          /* The tax number is NOT copied: it is unique per company and belongs
           * to one legal entity, so a duplicate would be refused anyway — and
           * copying it would suggest the two records are the same party. */
          commercialRegistrationNumber: source.commercialRegistrationNumber,
          paymentTerms: source.paymentTerms,
          defaultCurrency: source.defaultCurrency,
          notes: source.notes,
          supplier: source.supplier
            ? {
                supplierCategory: source.supplier.supplierCategory,
                defaultPayableAccountId: source.supplier.defaultPayableAccountId,
                defaultExpenseAccountId: source.supplier.defaultExpenseAccountId,
                supplierPaymentTerms: source.supplier.supplierPaymentTerms,
                withholdingTaxApplicable: source.supplier.withholdingTaxApplicable,
                preferredPaymentMethod: source.supplier.preferredPaymentMethod,
              }
            : undefined,
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
