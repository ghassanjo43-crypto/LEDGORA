import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, Copy, GitBranch, Send, Star, Archive, X, Palette, Plus, Pencil, Wand2 } from 'lucide-react';
import type { Invoice, InvoiceTemplate, InvoiceTemplateVersion } from '@/types/invoice';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from '@/store/invoiceTemplateStore';
import { useInvoiceTemplateEditor } from '@/store/invoiceTemplateEditorStore';
import { createInvoiceTemplateSnapshot } from '@/lib/invoiceTemplates';
import { makeSampleInvoice, sampleCompanyFromSettings, SAMPLE_CUSTOMER } from '@/lib/invoiceSample';
import { cn } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { InvoiceRenderer } from '@/components/invoices/InvoiceRenderer';
import { TemplateEditor } from '@/components/invoices/TemplateEditor';

export function InvoiceTemplatesPage() {
  const settings = useStore((s) => s.settings);
  const entities = useEntityStore((s) => s.entities);
  const store = useInvoiceTemplateStore();
  const editor = useInvoiceTemplateEditor();
  const { notify } = useToast();

  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const [confirmDraft, setConfirmDraft] = useState<{ templateId: string; publishedVersion: number } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);

  const templates = store.templates.filter((t) => !t.isArchived);
  const customTemplates = templates.filter((t) => !t.isSystemDefault);
  // Customers referencing this template (association lives on the customer record).
  const assignedCount = (templateId: string): number => entities.filter((e) => e.defaultInvoiceTemplateId === templateId).length;

  const act = (fn: () => { ok: boolean; error?: string }, success: string): void => {
    const res = fn();
    if (res.ok) notify(success, 'success'); else notify(res.error ?? 'Action failed.', 'error');
  };

  /** Open the editor on a template's draft version, creating one if needed. */
  const editDraft = (templateId: string): void => {
    const existing = store.versions.find((v) => v.templateId === templateId && v.status === 'draft');
    if (existing) { editor.openEditor(existing.id); return; }
    const res = store.createDraftVersion(templateId);
    if (res.ok && res.id) editor.openEditor(res.id);
    else notify(res.error ?? 'Could not create a draft version.', 'error');
  };

  const duplicateAndCustomize = (templateId: string): void => {
    const res = store.duplicateTemplate(templateId);
    if (res.ok && res.id) { editDraft(res.id); notify('Template duplicated — now editing your copy.', 'success'); }
    else notify(res.error ?? 'Could not duplicate.', 'error');
  };

  // Honour a cross-view request (e.g. from the invoice editor "Edit template").
  useEffect(() => {
    if (editor.requestOpenTemplateId) {
      editDraft(editor.requestOpenTemplateId);
      editor.requestOpen(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.requestOpenTemplateId]);

  const previewVersion = previewVersionId ? store.getVersion(previewVersionId) : undefined;
  const previewTemplate = previewVersion ? store.getTemplate(previewVersion.templateId) : undefined;

  // Full-page editor takes over the view.
  if (editor.editingVersionId) {
    return <TemplateEditor versionId={editor.editingVersionId} onClose={() => editor.closeEditor()} />;
  }

  return (
    <>
      <PageActions>
        <Button onClick={() => duplicateAndCustomize('tmpl_system_standard')}><Plus className="h-4 w-4" /> New Template</Button>
      </PageActions>

      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">Create and manage the formats used when invoices are printed, downloaded, or sent.</p>

      {customTemplates.length === 0 && (
        <Card className="mb-4">
          <CardBody>
            <EmptyState
              icon={Palette}
              title="Your company is currently using the Standard Invoice"
              description="Duplicate it to change the logo, colours, labels and columns — the built-in default always stays available."
            />
            <div className="mt-3 flex justify-center gap-2">
              <Button variant="outline" onClick={() => { const v = store.getTemplate('tmpl_system_standard'); if (v) setPreviewVersionId(v.currentVersionId); }}><Eye className="h-4 w-4" /> Preview Standard Invoice</Button>
              <Button onClick={() => duplicateAndCustomize('tmpl_system_standard')}><Wand2 className="h-4 w-4" /> Duplicate &amp; customize</Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
              <tr>{['Template', 'Current version', 'Draft', 'Default', 'Customers', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {templates.map((t) => {
                const versions = store.versions.filter((v) => v.templateId === t.id).sort((a, b) => b.versionNumber - a.versionNumber);
                const current = store.getVersion(t.currentVersionId) ?? versions.find((v) => v.status === 'published');
                const draft = versions.find((v) => v.status === 'draft');
                return (
                  <tr key={t.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2"><span className="font-medium">{t.name}</span>{t.isSystemDefault && <Badge tone="slate">system</Badge>}</div>
                      {t.description && <p className="text-xs text-slate-400">{t.description}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs">{current ? <>v{current.versionNumber} <Badge tone={current.status === 'published' ? 'green' : 'amber'}>{current.status}</Badge></> : '—'}</td>
                    <td className="px-3 py-2 text-xs">{draft ? <Badge tone="amber">v{draft.versionNumber} draft</Badge> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2">{t.isEntityDefault ? <Badge tone="blue">entity default</Badge> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{assignedCount(t.id)}</td>
                    <td className="px-3 py-2 text-right">
                      {t.isSystemDefault ? (
                        <Dropdown label="Actions" align="right" trigger={triggerBtn}>
                          {current && <MenuItem onClick={() => setPreviewVersionId(current.id)}><Eye className="h-4 w-4" /> Preview</MenuItem>}
                          <MenuItem onClick={() => setRenameId(t.id)}><Pencil className="h-4 w-4" /> Rename</MenuItem>
                          <MenuItem onClick={() => duplicateAndCustomize(t.id)}><Wand2 className="h-4 w-4" /> Duplicate &amp; customize</MenuItem>
                        </Dropdown>
                      ) : (
                        <Dropdown label="Actions" align="right" trigger={triggerBtn}>
                          {current && <MenuItem onClick={() => setPreviewVersionId(current.id)}><Eye className="h-4 w-4" /> Preview</MenuItem>}
                          <MenuItem onClick={() => setRenameId(t.id)}><Pencil className="h-4 w-4" /> Rename</MenuItem>
                          <MenuItem onClick={() => editDraft(t.id)}><Pencil className="h-4 w-4" /> {draft ? `Edit draft v${draft.versionNumber}` : 'Edit template'}</MenuItem>
                          {!draft && current?.status === 'published' && <MenuItem onClick={() => setConfirmDraft({ templateId: t.id, publishedVersion: current.versionNumber })}><GitBranch className="h-4 w-4" /> Create new version</MenuItem>}
                          {draft && <MenuItem onClick={() => act(() => store.publishVersion(draft.id), `Version ${draft.versionNumber} published.`)}><Send className="h-4 w-4" /> Publish draft</MenuItem>}
                          <MenuItem onClick={() => act(() => store.duplicateTemplate(t.id), 'Template duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                          {!t.isEntityDefault && <MenuItem onClick={() => act(() => store.makeEntityDefault(t.id, INVOICE_ENTITY_ID), 'Set as entity default.')}><Star className="h-4 w-4" /> Make entity default</MenuItem>}
                          <MenuItem onClick={() => act(() => store.archiveTemplate(t.id), 'Template archived.')}><Archive className="h-4 w-4" /> Archive</MenuItem>
                        </Dropdown>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {previewVersion && previewTemplate && (
        <PreviewModal onClose={() => setPreviewVersionId(null)} template={previewTemplate} version={previewVersion} settings={settings} />
      )}

      {renameId && <RenameModal templateId={renameId} onClose={() => setRenameId(null)} />}

      {/* Published → create draft confirmation */}
      {confirmDraft && (
        <Modal onClose={() => setConfirmDraft(null)} title="Create a new version?">
          <p className="text-sm text-slate-600 dark:text-slate-300">This version is published and may already be used by issued invoices. A new draft version will be created (Version {confirmDraft.publishedVersion + 1}) that you can edit and publish when ready.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDraft(null)}>Cancel</Button>
            <Button onClick={() => { editDraft(confirmDraft.templateId); setConfirmDraft(null); }}><GitBranch className="h-4 w-4" /> Create draft version</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

const triggerBtn = (o: boolean) => (
  <span className={cn('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>
);

function RenameModal({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const store = useInvoiceTemplateStore();
  const { notify } = useToast();
  const current = store.getTemplate(templateId);
  const [name, setName] = useState(current?.name ?? '');
  const [error, setError] = useState('');

  const save = (): void => {
    const res = store.renameTemplate(templateId, name);
    if (!res.ok) { setError(res.error ?? 'Could not rename the template.'); return; }
    notify('Template name updated.', 'success');
    onClose();
  };

  return (
    <Modal title="Rename template" onClose={onClose}>
      <label className="block text-xs text-slate-500">Template name
        <Input value={name} maxLength={80} autoFocus onChange={(e) => { setName(e.target.value); setError(''); }} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} className="mt-1" />
      </label>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!name.trim() || name.trim() === current?.name}>Save changes</Button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

function PreviewModal({ template, version, settings, onClose }: { template: InvoiceTemplate; version: InvoiceTemplateVersion; settings: ReturnType<typeof useStore.getState>['settings']; onClose: () => void }) {
  const snapshot = useMemo(() => createInvoiceTemplateSnapshot(template, version, sampleCompanyFromSettings(settings), SAMPLE_CUSTOMER), [template, version, settings]);
  const sample: Invoice = useMemo(() => makeSampleInvoice(settings.baseCurrency), [settings.baseCurrency]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/50 backdrop-blur-sm print:static print:bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 print:hidden dark:border-slate-800 dark:bg-slate-900">
        <div className="text-sm font-medium">{template.name} — v{version.versionNumber} <Badge tone={version.status === 'published' ? 'green' : 'amber'}>{version.status}</Badge></div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => window.print()}>Print / PDF</Button>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><InvoiceRenderer invoice={sample} snapshot={snapshot} /></div></div>
    </div>
  );
}

