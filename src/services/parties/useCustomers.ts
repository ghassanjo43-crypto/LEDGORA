/**
 * The one place a screen asks "who are this company's customers".
 *
 * Durable subscribers get the server directory; Free Demo gets the local
 * entity store. Screens do not branch on the engine themselves — a screen that
 * decided for itself is a screen that can be forgotten when the next role
 * migrates.
 *
 * The server party is mapped into `BusinessEntity`, the shape every existing
 * picker, drawer and selector already consumes. That mapping is what keeps this
 * slice small: nothing downstream has to learn a second customer type, and the
 * supplier-role fields it cannot know are left at their empty defaults rather
 * than invented.
 */
import { useMemo } from 'react';
import type { BusinessEntity, EntityType } from '@/types';
import type { PaymentTerms } from '@/types';
import type { ServerBusinessParty } from '@/services/api/customersApi';
import { useEntityStore } from '@/store/useEntityStore';
import { isCustomer } from '@/lib/entitySelectors';
import { useCustomerDirectory, customersAreServerAuthoritative } from './customerDirectory';

/**
 * A server party as the existing screens expect to see it.
 *
 * `entityType` reports only what this route can know. A party that is also a
 * supplier is still rendered as a customer here, because the supplier profile
 * has not migrated and claiming the role would promise purchasing data that no
 * server table holds yet.
 */
export function partyToEntity(party: ServerBusinessParty): BusinessEntity {
  const primary = party.addresses.find((a) => a.isPrimary && a.purpose === 'billing')
    ?? party.addresses.find((a) => a.purpose === 'billing')
    ?? party.addresses[0];

  const entityType: EntityType = party.isSupplier ? 'both' : 'customer';

  return {
    id: party.id,
    entityCode: party.partyCode,
    legalName: party.legalName,
    tradingName: party.tradingName,
    entityType,

    contactPerson: party.contactPerson,
    jobTitle: party.jobTitle,
    email: party.email,
    phone: party.phone,
    mobile: party.mobile,
    website: party.website,

    country: primary?.country ?? '',
    city: primary?.city ?? '',
    addressLine1: primary?.addressLine1 ?? '',
    addressLine2: primary?.addressLine2 ?? '',
    postalCode: primary?.postalCode ?? '',

    taxRegistrationNumber: party.taxRegistrationNumber,
    commercialRegistrationNumber: party.commercialRegistrationNumber,
    paymentTerms: (party.paymentTerms || 'NET_30') as PaymentTerms,
    defaultCurrency: party.defaultCurrency,

    bankName: party.bankName,
    bankAccountName: party.bankAccountName,
    iban: party.iban,
    swiftCode: party.swiftCode,

    notes: party.notes,
    /* Archived is the durable equivalent of inactive: hidden from pickers,
     * never removed. */
    isActive: party.status === 'active',
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,

    customerCategory: party.customer?.customerCategory ?? '',
    /*
     * The one lossy step, and it is confined to DISPLAY.
     *
     * `BusinessEntity.creditLimit` is a `number` and every screen reading it
     * expects one. The authoritative value stays the decimal string on the
     * server; nothing writes this back, and the write path sends the string.
     */
    creditLimit: Number(party.customer?.creditLimit ?? '0'),
    defaultRevenueAccount: party.customer?.defaultRevenueAccountId ?? '',
    defaultReceivableAccount: party.customer?.defaultReceivableAccountId ?? '',
    defaultInvoiceTemplateId: party.customer?.defaultInvoiceTemplateId ?? '',
    invoiceDeliveryMethod: (party.customer?.invoiceDeliveryMethod ?? '') as BusinessEntity['invoiceDeliveryMethod'],
    customerPaymentTerms: (party.customer?.customerPaymentTerms ?? '') as BusinessEntity['customerPaymentTerms'],

    /* Supplier-only fields stay at their defaults. This route cannot read them
     * and must not appear to. */
    supplierCategory: '',
    defaultExpenseAccount: '',
    defaultPayableAccount: '',
    supplierPaymentTerms: '',
    withholdingTaxApplicable: false,
    preferredPaymentMethod: '',
  };
}

export interface CustomerDirectoryView {
  customers: BusinessEntity[];
  /** True when these came from the server rather than the browser. */
  serverBacked: boolean;
  loading: boolean;
  error: string | null;
}

export function useCustomers(): CustomerDirectoryView {
  const serverBacked = customersAreServerAuthoritative();
  const directory = useCustomerDirectory();
  const localEntities = useEntityStore((s) => s.entities);

  const customers = useMemo(() => {
    if (serverBacked) return directory.customers.map(partyToEntity);
    /* Free Demo: the local directory, filtered to the customer role exactly as
     * every picker already did. */
    return localEntities.filter(isCustomer);
  }, [serverBacked, directory.customers, localEntities]);

  return {
    customers,
    serverBacked,
    loading: serverBacked && directory.state === 'loading',
    error: serverBacked ? directory.error : null,
  };
}
