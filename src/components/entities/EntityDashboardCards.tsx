import { UserRound, Truck, ArrowLeftRight, Moon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EntityStats } from '@/lib/entitySelectors';
import { MetricCard, type MetricTone } from '@/components/ui/MetricCard';

export function EntityDashboardCards({ stats }: { stats: EntityStats }) {
  const cards: {
    label: string;
    value: number;
    icon: LucideIcon;
    tone: MetricTone;
    hint?: string;
  }[] = [
    { label: 'Total customers', value: stats.totalCustomers, icon: UserRound, tone: 'emerald', hint: 'Entities we invoice' },
    { label: 'Total suppliers', value: stats.totalSuppliers, icon: Truck, tone: 'amber', hint: 'Entities who invoice us' },
    { label: 'Customer & supplier', value: stats.both, icon: ArrowLeftRight, tone: 'violet', hint: 'Shared, not duplicated' },
    { label: 'Inactive entities', value: stats.inactive, icon: Moon, tone: 'slate', hint: `${stats.total} total` },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <MetricCard key={c.label} {...c} />
      ))}
    </div>
  );
}
