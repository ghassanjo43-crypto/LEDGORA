/**
 * Whether the configured bank-remittance details are still the shipped
 * placeholders.
 *
 * The authoritative answer is the structured `isPlaceholder` flag on
 * `BankDetails` — set on the seeded defaults and cleared the first time an
 * administrator saves real details. The heuristic below is only a safety net for
 * settings persisted before the flag existed, so an old install cannot silently
 * present example account numbers as if they were real.
 */
import type { BankDetails } from '@/types/billing';

/** Account identifiers that ship with the product and are never real. */
const PLACEHOLDER_ACCOUNT_NUMBERS = ['0123456789'];
const PLACEHOLDER_SWIFTS = ['LEDGAEXX'];

/** An IBAN made only of zeros/spaces after the country prefix is not real. */
function ibanIsBlank(iban: string): boolean {
  const digits = iban.replace(/\s+/g, '').slice(2);
  return digits.length === 0 || /^0+$/.test(digits);
}

export function isPlaceholderBankConfig(bank: BankDetails | undefined | null): boolean {
  if (!bank) return true;
  // Explicit flag wins in both directions once it has been set.
  if (typeof bank.isPlaceholder === 'boolean') return bank.isPlaceholder;

  // Legacy settings (no flag): fall back to recognising the shipped values.
  return (
    /\(example\)/i.test(bank.bankName) ||
    PLACEHOLDER_ACCOUNT_NUMBERS.includes(bank.accountNumber.replace(/\s+/g, '')) ||
    PLACEHOLDER_SWIFTS.includes(bank.swift.toUpperCase()) ||
    ibanIsBlank(bank.iban)
  );
}

/**
 * Have any of the identifying fields been given a real value? Used to clear the
 * placeholder flag when an administrator edits the bank configuration.
 */
export function patchLeavesPlaceholder(current: BankDetails, patch: Partial<BankDetails>): boolean {
  if (patch.isPlaceholder !== undefined) return patch.isPlaceholder;
  const next: BankDetails = { ...current, ...patch, isPlaceholder: undefined };
  const identifying: Array<keyof BankDetails> = ['bankName', 'accountName', 'accountNumber', 'iban', 'swift'];
  const changed = identifying.some((key) => patch[key] !== undefined && patch[key] !== current[key]);
  if (!changed) return isPlaceholderBankConfig(current);
  // Re-evaluate the edited details on their own merits.
  return isPlaceholderBankConfig(next);
}
