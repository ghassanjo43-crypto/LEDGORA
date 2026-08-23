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
 * one at a time.
 *
 * ── Destruction is staged ────────────────────────────────────────────────────
 * Archive, then delete — never one click. An archived entity keeps every
 * record and can be restored; only an archived one may be deleted, and that
 * asks again before it does. These books live in this browser and nowhere
 * else, so there is no copy to recover from afterwards.
 */
import { useState } from 'react';
import { Building2, Power, PowerOff, LogIn, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { useCompanyStore, entityStatus, activeEntityCount, entityAllowance, type EntityStatus } from '@/store/companyStore';
import { useStore } from '@/store/useStore';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { AddCompanyDialog } from '@/components/company/AddCompanyDialog';

const STATUS_LABEL: Record<EntityStatus, string> = {
  active: 'Active',
  inactive: 'Deactivated',
  archived: 'Archived',
};

const STATUS_TONE: Record<EntityStatus, 'green' | 'slate' | 'amber'> = {
  active: 'green',
  inactive: 'slate',
  archived: 'amber',
};

export function CompaniesPage() {
  const companies = useCompanyStore((s) => s.companies);
  const activeCompanyId = useCompanyStore((s) => s.activeCompanyId);
  const switchCompany = useCompanyStore((s) => s.switchCompany);
  const activateCompany = useCompanyStore((s) => s.activateCompany);
  const deactivateCompany = useCompanyStore((s) => s.deactivateCompany);
  const archiveCompany = useCompanyStore((s) => s.archiveCompany);
  const restoreCompany = useCompanyStore((s) => s.restoreCompany);
  const deleteCompany = useCompanyStore((s) => s.deleteCompany);
  const liveSettings = useStore((s) => s.settings);
  const { notify } = useToast();

  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  /* Deletion is irreversible and there is no server copy, so it is confirmed in place. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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
      status: entityStatus(company),
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
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Companies</h1>
          <p className="text-sm text-slate-500">
            Each company is a separate entity — its own set of books. Your package allows {allowance}{' '}
            active {allowance === 1 ? 'entity' : 'entities'}. Deactivating frees a slot and archiving retires an entity —
            both keep every record, and an entity must be archived before it can be deleted.
          </p>
        </div>
        <Button disabled={atLimit} onClick={() => setAddOpen(true)}>Add company</Button>
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
          description="Open an entity to work in its books, deactivate one you are not using, or archive one you have finished with."
          actions={
            <Input
              aria-label="Search companies"
              placeholder="Search companies"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          }
        />
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              {companies.length === 0 ? 'No companies yet.' : 'No company matches that search.'}
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800">
                <tr>
                  <th className="px-4 py-3">Company</th>
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
                      <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        {row.status === 'active' && !row.open && (
                          <Button size="sm" variant="outline" onClick={() => act(switchCompany(row.id), `Opened ${row.name}.`)}>
                            <LogIn className="h-4 w-4" /> Open
                          </Button>
                        )}
                        {row.status === 'active' && (
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
                        )}
                        {row.status === 'inactive' && (
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
                        {row.status !== 'archived' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={row.open}
                            title={row.open ? 'Open another entity first' : undefined}
                            onClick={() => act(archiveCompany(row.id), `${row.name} archived. Its records are kept and it can be restored.`)}
                          >
                            <Archive className="h-4 w-4" /> Archive
                          </Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" onClick={() => act(restoreCompany(row.id), `${row.name} restored, deactivated. Activate it to open its books.`)}>
                              <ArchiveRestore className="h-4 w-4" /> Restore
                            </Button>
                            {/*
                              * Delete is reachable ONLY from archived, and only
                              * after a second, explicit confirmation: these books
                              * exist in this browser and nowhere else.
                              */}
                            {confirmDelete === row.id ? (
                              <>
                                <Button size="sm" variant="danger" onClick={() => { act(deleteCompany(row.id), `${row.name} deleted.`); setConfirmDelete(null); }}>
                                  Delete permanently
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                              </>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(row.id)}>
                                <Trash2 className="h-4 w-4" /> Delete
                              </Button>
                            )}
                          </>
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
