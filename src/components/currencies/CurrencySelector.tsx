import type { Currency } from '@/types/currency';
import { Select } from '@/components/ui/Select';

interface Props {
  value: string;
  onChange: (code: string) => void;
  currencies: Currency[];
  /** Only show these codes (e.g. an entity's enabled set). */
  allowed?: string[];
  includeInactive?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Shared currency dropdown — active currencies (optionally restricted to an allowed set). */
export function CurrencySelector({ value, onChange, currencies, allowed, includeInactive, disabled, className, ...rest }: Props) {
  const options = currencies
    .filter((c) => (includeInactive ? true : c.status === 'active'))
    .filter((c) => (allowed ? allowed.includes(c.code) : true))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((c) => ({ value: c.code, label: `${c.code} · ${c.symbol}` }));
  return <Select className={className} options={options} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={rest['aria-label']} />;
}
