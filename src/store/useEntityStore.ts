import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { BusinessEntity, EntityType } from '@/types';
import type { EntityFormValues } from '@/lib/entityValidation';
import { SEED_ENTITIES } from '@/data/seedEntities';
import { generateId, nowIso } from '@/lib/utils';

export interface EntityActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/** Reconcile role-specific fields when an entity's type changes. */
function reconcileRoleFields(entity: BusinessEntity, type: EntityType): BusinessEntity {
  const isCustomer = type === 'customer' || type === 'both';
  const isSupplier = type === 'supplier' || type === 'both';
  return {
    ...entity,
    entityType: type,
    // Clear customer-only data when the entity is no longer a customer.
    customerCategory: isCustomer ? entity.customerCategory : '',
    creditLimit: isCustomer ? entity.creditLimit : 0,
    defaultRevenueAccount: isCustomer ? entity.defaultRevenueAccount : '',
    defaultReceivableAccount: isCustomer ? entity.defaultReceivableAccount : '',
    defaultInvoiceTemplateId: isCustomer ? entity.defaultInvoiceTemplateId : '',
    invoiceDeliveryMethod: isCustomer ? entity.invoiceDeliveryMethod : '',
    customerPaymentTerms: isCustomer ? entity.customerPaymentTerms : '',
    // Clear supplier-only data when the entity is no longer a supplier.
    supplierCategory: isSupplier ? entity.supplierCategory : '',
    defaultExpenseAccount: isSupplier ? entity.defaultExpenseAccount : '',
    defaultPayableAccount: isSupplier ? entity.defaultPayableAccount : '',
    supplierPaymentTerms: isSupplier ? entity.supplierPaymentTerms : '',
    withholdingTaxApplicable: isSupplier ? entity.withholdingTaxApplicable : false,
    preferredPaymentMethod: isSupplier ? entity.preferredPaymentMethod : '',
    updatedAt: nowIso(),
  };
}

function entityFromForm(
  values: EntityFormValues,
  base: Pick<BusinessEntity, 'id' | 'createdAt'>,
): BusinessEntity {
  const normalized: BusinessEntity = {
    ...values,
    entityCode: values.entityCode.trim(),
    legalName: values.legalName.trim(),
    iban: values.iban.replace(/\s+/gu, '').toUpperCase(),
    swiftCode: values.swiftCode.toUpperCase(),
    defaultCurrency: values.defaultCurrency.toUpperCase(),
    id: base.id,
    createdAt: base.createdAt,
    updatedAt: nowIso(),
  };
  // Ensure role fields stay consistent with the chosen type.
  return reconcileRoleFields(normalized, values.entityType);
}

interface EntityState {
  entities: BusinessEntity[];

  addEntity: (values: EntityFormValues) => EntityActionResult;
  updateEntity: (id: string, values: EntityFormValues) => EntityActionResult;
  deleteEntity: (id: string) => EntityActionResult;
  duplicateEntity: (id: string) => EntityActionResult;
  setActive: (id: string, isActive: boolean) => void;
  setEntityType: (id: string, type: EntityType) => void;
  replaceAll: (entities: BusinessEntity[]) => void;
  resetToDefault: () => void;
}

function checkUniqueness(
  entities: BusinessEntity[],
  values: Pick<EntityFormValues, 'entityCode' | 'taxRegistrationNumber'>,
  ignoreId?: string,
): string | null {
  const code = values.entityCode.trim().toLowerCase();
  if (entities.some((e) => e.id !== ignoreId && e.entityCode.trim().toLowerCase() === code)) {
    return `Entity code "${values.entityCode}" already exists.`;
  }
  const tax = values.taxRegistrationNumber.trim().toLowerCase();
  if (tax && entities.some((e) => e.id !== ignoreId && e.taxRegistrationNumber.trim().toLowerCase() === tax)) {
    return `Tax registration number "${values.taxRegistrationNumber}" is already used by another entity.`;
  }
  return null;
}

export const useEntityStore = create<EntityState>()(
  persist(
    (set, get) => ({
      entities: SEED_ENTITIES,

      addEntity: (values) => {
        const { entities } = get();
        const conflict = checkUniqueness(entities, values);
        if (conflict) return { ok: false, error: conflict };

        const id = generateId('ent');
        const created = entityFromForm(values, { id, createdAt: nowIso() });
        set({ entities: [...entities, created] });
        return { ok: true, id };
      },

      updateEntity: (id, values) => {
        const { entities } = get();
        const existing = entities.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Entity not found.' };

        const conflict = checkUniqueness(entities, values, id);
        if (conflict) return { ok: false, error: conflict };

        const updated = entityFromForm(values, { id, createdAt: existing.createdAt });
        set({ entities: entities.map((e) => (e.id === id ? updated : e)) });
        return { ok: true, id };
      },

      deleteEntity: (id) => {
        const { entities } = get();
        if (!entities.some((e) => e.id === id)) return { ok: false, error: 'Entity not found.' };
        set({ entities: entities.filter((e) => e.id !== id) });
        return { ok: true };
      },

      duplicateEntity: (id) => {
        const { entities } = get();
        const source = entities.find((e) => e.id === id);
        if (!source) return { ok: false, error: 'Entity not found.' };

        const used = new Set(entities.map((e) => e.entityCode.toLowerCase()));
        let candidate = `${source.entityCode}-COPY`;
        let n = 1;
        while (used.has(candidate.toLowerCase())) {
          n += 1;
          candidate = `${source.entityCode}-COPY${n}`;
        }
        const newId = generateId('ent');
        const now = nowIso();
        const copy: BusinessEntity = {
          ...source,
          id: newId,
          entityCode: candidate,
          legalName: `${source.legalName} (copy)`,
          taxRegistrationNumber: '', // avoid unique-tax clash
          createdAt: now,
          updatedAt: now,
        };
        set({ entities: [...entities, copy] });
        return { ok: true, id: newId };
      },

      setActive: (id, isActive) =>
        set((s) => ({
          entities: s.entities.map((e) =>
            e.id === id ? { ...e, isActive, updatedAt: nowIso() } : e,
          ),
        })),

      setEntityType: (id, type) =>
        set((s) => ({
          entities: s.entities.map((e) => (e.id === id ? reconcileRoleFields(e, type) : e)),
        })),

      replaceAll: (entities) => set({ entities }),

      resetToDefault: () => set({ entities: SEED_ENTITIES.map((e) => ({ ...e })) }),
    }),
    {
      name: 'ifrs-entity-store', storage: businessJSONStorage,
      version: 1,
      partialize: (state) => ({ entities: state.entities }),
    },
  ),
);

/** Default form values for a new entity of the given scope. */
export function makeDefaultEntityValues(type: EntityType = 'customer'): EntityFormValues {
  return {
    entityCode: '',
    legalName: '',
    tradingName: '',
    entityType: type,
    contactPerson: '',
    jobTitle: '',
    email: '',
    phone: '',
    mobile: '',
    website: '',
    country: 'United Arab Emirates',
    city: '',
    addressLine1: '',
    addressLine2: '',
    postalCode: '',
    taxRegistrationNumber: '',
    commercialRegistrationNumber: '',
    paymentTerms: 'NET_30',
    defaultCurrency: 'AED',
    bankName: '',
    bankAccountName: '',
    iban: '',
    swiftCode: '',
    notes: '',
    isActive: true,
    customerCategory: '',
    creditLimit: 0,
    defaultRevenueAccount: '',
    defaultReceivableAccount: '',
    defaultInvoiceTemplateId: '',
    invoiceDeliveryMethod: '',
    customerPaymentTerms: '',
    supplierCategory: '',
    defaultExpenseAccount: '',
    defaultPayableAccount: '',
    supplierPaymentTerms: '',
    withholdingTaxApplicable: false,
    preferredPaymentMethod: '',
  };
}

/** Map an existing entity into form values for editing. */
export function entityToFormValues(entity: BusinessEntity): EntityFormValues {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = entity;
  void _id;
  void _createdAt;
  void _updatedAt;
  return rest;
}
