/**
 * The subscriber's entities — the sets of books they keep.
 *
 * ── Why this page exists ─────────────────────────────────────────────────────
 * Entities were reachable only through the Topbar switcher, which can open one
 * and delete one and nothing else. A subscriber whose package allows several
 * had no way to see what they had, and no way to stop using one without
 * destroying it.
 *
 * ── Active is a package slot, not a state of the books ───────────────────────
 * The package caps how many entities may be ACTIVE at once. Deactivating frees
 * a slot and keeps every record exactly where it is, so a subscriber on a
 * one-entity package can hold several years or several businesses and work in
 * one at a time. Nothing here deletes anything; deletion stays where it was.
 */
import { useState } from 'react';
import { Building2, Power, PowerOff, LogIn } from 'lucide-react';
import { useCompanyStore, isActiveEntity, activeEntityCount, entityAllowance } from '@/store/companyStore';
import { useStore } from '@/store/useStore';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { AddCompanyDialog } from '@/components/company/AddCompanyDialog';

export function CompaniesPage() {
  const companies = useCompanyStore((s) => s.companies);
  const activeCompanyId = useCompanyStore((s) => s.activeCompanyId);
  const switchCompany = useCompanyStore((s) => s.switchCompany);
  const activateCompany = useCompanyStore((s) => s.activateCompany);
  const deactivateCompany = useCompanyStore((s) => s.deactivateCompany);
  const liveSettings = useStore((s) => s.settings);
  const { notify } = useToast();

  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const allowance = entityAllowance();
  const used = activeEntityCount(companies);
  const atLimit = used >= allowance;

  /*
   * The open entity's name lives in the working store, not in the registry
   * snapshot — the snapshot is only refreshed when you switch away, so reading
   * it here would show a stale name for the company you are looking at.
   */
  const nameOf = (id: string, fallback: string): string =>
    id === activeCompanyId ? liveSettings.companyName : fallback;

  const rows = companies
    .map((company) => ({
      id: company.id,
      name: nameOf(company.id, company.settings.companyName),
      currency: company.id === activeCompanyId ? liveSettings.baseCurrency : company.settings.baseCurrency,
      active: isActiveEntity(company),
      open: company.id === activeCompanyId,
    }))
    .filter((row) => row.name.toLowerCase().includes(query.trim().toLowerCase()));

  const act = (result: { ok: boolean; error?: string }, success: string): void => {
    notify(result.ok ? success : result.error ?? 'That did not work.', result.ok ? 'success' : 'error');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Entities</h1>
          <p className="text-sm text-slate-500">
            Each entity is a separate set of books. Your package allows {allowance}{' '}
            active {allowance === 1 ? 'entity' : 'entities'}; deactivating one keeps its records and frees a slot.
          </p>
        </div>
        <Button disabled={atLimit} onClick={() => setAddOpen(true)}>Add entity</Button>
      </div>

      {atLimit && (
        <Alert variant="info">
          <strong>All {allowance} {allowance === 1 ? 'slot is' : 'slots are'} in use.</strong>{' '}
          Deactivate an entity below to free one, or upgrade your package to keep more open at once.
          Deactivating never deletes anything.
        </Alert>
      )}

      <Card>
        <CardHeader
          title={`${used} of ${allowance} active`}
          description="Open an entity to work in its books, or deactivate one you are not using."
          actions={
            <Input
              aria-label="Search entities"
              placeholder="Search by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          }
        />
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              {companies.length === 0 ? 'No entities yet.' : 'No entity matches that search.'}
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800">
                <tr>
                  <th className="px-4 py-3">Entity</th>
                  <th>Base currency</th>
                  <th>Status</th>
                  <th className="px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t dark:border-slate-800" data-testid={`entity-row-${row.id}`}>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-medium">
                        <Building2 className="h-4 w-4 text-slate-400" />
                        {row.name}
                        {row.open && <Badge tone="blue">Open</Badge>}
                      </span>
                    </td>
                    <td className="text-slate-500">{row.currency}</td>
                    <td>
                      <Badge tone={row.active ? 'green' : 'slate'}>{row.active ? 'Active' : 'Deactivated'}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        {row.active && !row.open && (
                          <Button size="sm" variant="outline" onClick={() => act(switchCompany(row.id), `Opened ${row.name}.`)}>
                            <LogIn className="h-4 w-4" /> Open
                          </Button>
                        )}
                        {row.active ? (
                          <Button
                            size="sm"
                            variant="outline"
                            // The open entity cannot be deactivated: its books
                            // are the ones currently loaded in every store.
                            disabled={row.open}
                            title={row.open ? 'Open another entity first' : undefined}
                            onClick={() => act(deactivateCompany(row.id), `${row.name} deactivated. Its records are kept.`)}
                          >
                            <PowerOff className="h-4 w-4" /> Deactivate
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={atLimit}
                            title={atLimit ? 'No free slot — deactivate another entity first' : undefined}
                            onClick={() => act(activateCompany(row.id), `${row.name} activated.`)}
                          >
                            <Power className="h-4 w-4" /> Activate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <AddCompanyDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
