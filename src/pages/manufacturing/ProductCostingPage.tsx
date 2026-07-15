import { useManufacturingStore } from '@/store/manufacturingStore';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { money, useItemName } from './ManufacturingShared';

export function ProductCostingPage() {
  const versions = useManufacturingStore((s) => s.standardCostVersions);
  const itemName = useItemName();
  return (
    <div className="space-y-4">
      <Card className="overflow-x-auto">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">Standard cost versions</div>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Product</th><th className="px-4 py-2 text-left">Effective</th><th className="px-4 py-2 text-right">Material</th><th className="px-4 py-2 text-right">Labor</th><th className="px-4 py-2 text-right">Machine</th><th className="px-4 py-2 text-right">Overhead</th><th className="px-4 py-2 text-right">Unit cost</th><th className="px-4 py-2 text-left">Status</th></tr>
          </thead>
          <tbody>
            {[...versions].reverse().map((v) => (
              <tr key={v.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{itemName(v.itemId)}</td>
                <td className="px-4 py-2 text-slate-500">{v.effectiveFrom}{v.effectiveTo ? ` → ${v.effectiveTo}` : ''}</td>
                <td className="px-4 py-2 text-right">{money(v.breakdown.materialCost)}</td>
                <td className="px-4 py-2 text-right">{money(v.breakdown.laborCost)}</td>
                <td className="px-4 py-2 text-right">{money(v.breakdown.machineCost)}</td>
                <td className="px-4 py-2 text-right">{money(v.breakdown.overheadCost)}</td>
                <td className="px-4 py-2 text-right font-semibold">{money(v.breakdown.unitCost)}</td>
                <td className="px-4 py-2"><Badge tone={v.status === 'active' ? 'green' : 'slate'}>{v.status}</Badge></td>
              </tr>
            ))}
            {versions.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No standard cost versions.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
