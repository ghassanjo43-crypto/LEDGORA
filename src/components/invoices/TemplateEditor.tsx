import { useMemo, useState } from 'react';
import { Save, Send, Eye, X, Layout, Palette, Type, Columns3, Banknote, FileText, Languages, GitBranch } from 'lucide-react';
import type { InvoiceContentConfig, InvoiceLayoutConfig, InvoiceStyleConfig, InvoiceColumnConfig } from '@/types/invoice';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { useInvoiceTemplateEditor, type TemplateEditorTab } from '@/store/invoiceTemplateEditorStore';
import { createInvoiceTemplateSnapshot } from '@/lib/invoiceTemplates';
import { makeDefaultLayoutConfig, makeDefaultStyleConfig, makeDefaultContentConfig } from '@/data/invoiceTemplates';
import { makeSampleInvoice, sampleCompanyFromSettings, SAMPLE_CUSTOMER } from '@/lib/invoiceSample';
import { logoConfigOf } from '@/lib/invoiceLogo';
import { LogoControl } from './LogoControl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { InvoiceRenderer } from './InvoiceRenderer';

const TABS: { id: TemplateEditorTab; label: string; icon: typeof Layout }[] = [
  { id: 'layout', label: 'Layout', icon: Layout },
  { id: 'branding', label: 'Branding', icon: Palette },
  { id: 'content', label: 'Content', icon: Type },
  { id: 'columns', label: 'Columns', icon: Columns3 },
  { id: 'payment', label: 'Payment Details', icon: Banknote },
  { id: 'terms', label: 'Terms & Footer', icon: FileText },
  { id: 'language', label: 'Language', icon: Languages },
  { id: 'preview', label: 'Preview', icon: Eye },
];

const LABEL_KEYS: { key: string; fallback: string }[] = [
  { key: 'invoiceNumber', fallback: 'Invoice No.' }, { key: 'issueDate', fallback: 'Issue date' }, { key: 'dueDate', fallback: 'Due date' },
  { key: 'billTo', fallback: 'Bill to' }, { key: 'description', fallback: 'Description' }, { key: 'quantity', fallback: 'Qty' },
  { key: 'unitPrice', fallback: 'Unit price' }, { key: 'tax', fallback: 'Tax' }, { key: 'total', fallback: 'Total' }, { key: 'balanceDue', fallback: 'Balance due' },
];

export function TemplateEditor({ versionId, onClose }: { versionId: string; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const store = useInvoiceTemplateStore();
  const editor = useInvoiceTemplateEditor();
  const { notify } = useToast();

  const entities = useEntityStore((s) => s.entities);
  const version = store.getVersion(versionId);
  const template = version ? store.getTemplate(version.templateId) : undefined;
  const assignedCount = template ? entities.filter((e) => e.defaultInvoiceTemplateId === template.id).length : 0;

  const [layout, setLayout] = useState<InvoiceLayoutConfig>(() => structuredCopy(version?.layoutConfig ?? makeDefaultLayoutConfig()));
  const [style, setStyle] = useState<InvoiceStyleConfig>(() => structuredCopy(version?.styleConfig ?? makeDefaultStyleConfig()));
  const [content, setContent] = useState<InvoiceContentConfig>(() => structuredCopy(version?.contentConfig ?? makeDefaultContentConfig()));
  const [loadedId, setLoadedId] = useState(versionId);
  const [nameDraft, setNameDraft] = useState(template?.name ?? '');
  const [nameError, setNameError] = useState('');
  if (version && loadedId !== versionId) {
    setLoadedId(versionId);
    setLayout(structuredCopy(version.layoutConfig));
    setStyle(structuredCopy(version.styleConfig));
    setContent(structuredCopy(version.contentConfig));
    setNameDraft(template?.name ?? '');
    setNameError('');
  }

  const previewSnapshot = useMemo(
    () => template && version ? createInvoiceTemplateSnapshot({ ...template }, { ...version, layoutConfig: layout, styleConfig: style, contentConfig: content }, sampleCompanyFromSettings(settings), SAMPLE_CUSTOMER) : null,
    [template, version, layout, style, content, settings],
  );
  const sample = useMemo(() => makeSampleInvoice(settings.baseCurrency), [settings.baseCurrency]);

  if (!version || !template) {
    return <div className="p-6 text-sm text-slate-500">Template version not found. <button className="text-brand-600 underline" onClick={onClose}>Close</button></div>;
  }

  const readOnly = version.status !== 'draft';

  const save = (): boolean => {
    const res = store.updateVersion(versionId, { layoutConfig: layout, styleConfig: style, contentConfig: content });
    if (!res.ok) { notify(res.error ?? 'Could not save.', 'error'); return false; }
    return true;
  };
  const onSave = (): void => { if (save()) notify('Draft version saved.', 'success'); };
  const onPublish = (): void => {
    if (!save()) return;
    const res = store.publishVersion(versionId);
    if (res.ok) { notify(`Version ${version.versionNumber} published.`, 'success'); onClose(); }
    else notify(res.error ?? 'Could not publish.', 'error');
  };

  const activeTab = editor.activeTab;
  const setLabel = (key: string, value: string): void => setContent({ ...content, customLabels: { ...content.customLabels, [key]: value } });

  const nameChanged = nameDraft.trim() !== template.name;
  const saveName = (): void => {
    const res = store.renameTemplate(template.id, nameDraft);
    if (!res.ok) { setNameError(res.error ?? 'Could not rename the template.'); return; }
    setNameError('');
    setNameDraft(nameDraft.trim());
    notify('Template name updated.', 'success');
  };

  const onManageCompanyLogo = (): void => { if (!readOnly) save(); editor.closeEditor(); setActiveView('settings'); };
  const createDraftAndEdit = (): void => {
    const res = store.createDraftVersion(template.id);
    if (res.ok && res.id) { editor.openEditor(res.id); notify('New draft version created.', 'success'); }
    else notify(res.error ?? 'Could not create a draft.', 'error');
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-slate-950">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="tmpl-name" className="sr-only">Template name</label>
            <input
              id="tmpl-name"
              value={nameDraft}
              maxLength={80}
              aria-label="Template name"
              onChange={(e) => { setNameDraft(e.target.value); setNameError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && nameChanged) { e.preventDefault(); saveName(); } }}
              className={cn(
                'min-w-[16rem] rounded-md border bg-transparent px-2 py-1 text-base font-bold text-slate-900 transition-colors focus:bg-white focus:outline-none dark:text-white dark:focus:bg-slate-900',
                nameError ? 'border-red-400 focus:border-red-500' : 'border-transparent hover:border-slate-200 focus:border-brand-400 dark:hover:border-slate-700',
              )}
            />
            {nameChanged && <Button size="sm" variant="secondary" onClick={saveName}><Save className="h-4 w-4" /> Save name</Button>}
            <Badge tone={version.status === 'published' ? 'green' : 'amber'}>v{version.versionNumber} · {version.status}</Badge>
            {template.isEntityDefault && <Badge tone="blue">entity default</Badge>}
            {template.isSystemDefault && <Badge tone="slate">system</Badge>}
          </div>
          {nameError
            ? <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{nameError}</p>
            : <p className="mt-0.5 text-xs text-slate-500">{assignedCount} assigned customer{assignedCount === 1 ? '' : 's'}</p>}
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && <Button variant="secondary" onClick={onSave}><Save className="h-4 w-4" /> Save draft</Button>}
          <Button variant="outline" onClick={() => editor.setTab('preview')}><Eye className="h-4 w-4" /> Preview</Button>
          {!readOnly && <Button onClick={onPublish}><Send className="h-4 w-4" /> Publish</Button>}
          <Button variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Close</Button>
        </div>
      </header>

      {readOnly && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <GitBranch className="h-4 w-4" /> This version is published and may already be used by issued invoices — create a new version to make changes.
          <Button variant="outline" size="sm" onClick={createDraftAndEdit} className="ml-auto"><GitBranch className="h-4 w-4" /> Create draft version</Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Tabs + form */}
        <div className="flex min-h-0 w-full flex-col lg:w-1/2 lg:border-r lg:border-slate-200 lg:dark:border-slate-800">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button key={t.id} type="button" onClick={() => editor.setTab(t.id)}
                  className={cn('flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium', activeTab === t.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                  <Icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {activeTab === 'layout' && (
              <Section title="Page & layout">
                <Row><FieldSel label="Page size" value={layout.pageSize} opts={[['A4', 'A4'], ['Letter', 'Letter']]} onChange={(v) => setLayout({ ...layout, pageSize: v as InvoiceLayoutConfig['pageSize'] })} disabled={readOnly} />
                  <FieldSel label="Orientation" value={layout.orientation} opts={[['portrait', 'Portrait'], ['landscape', 'Landscape']]} onChange={(v) => setLayout({ ...layout, orientation: v as InvoiceLayoutConfig['orientation'] })} disabled={readOnly} /></Row>
                <FieldSel label="Header layout" value={layout.headerLayout} opts={[['logo-left', 'Logo left'], ['logo-right', 'Logo right'], ['centered', 'Centered'], ['compact', 'Compact']]} onChange={(v) => setLayout({ ...layout, headerLayout: v as InvoiceLayoutConfig['headerLayout'] })} disabled={readOnly} />
                <Row>
                  {(['top', 'right', 'bottom', 'left'] as const).map((m) => (
                    <FieldNum key={m} label={`Margin ${m}`} value={layout.margins[m]} onChange={(n) => setLayout({ ...layout, margins: { ...layout.margins, [m]: n } })} disabled={readOnly} />
                  ))}
                </Row>
                <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Section visibility</p>
                <div className="grid grid-cols-2 gap-2">
                  {layout.sections.map((s) => (
                    <ToggleRow key={s.kind} label={s.kind} checked={s.visible} disabled={readOnly} onChange={(v) => setLayout({ ...layout, sections: layout.sections.map((x) => (x.kind === s.kind ? { ...x, visible: v } : x)) })} />
                  ))}
                </div>
              </Section>
            )}

            {activeTab === 'branding' && (
              <LogoControl
                value={logoConfigOf(content)}
                companyDefaultLogoUrl={settings.logoUrl}
                disabled={readOnly}
                onChange={(logo) => {
                  const next = { ...content, logo, showLogo: logo.mode !== 'hidden' };
                  setContent(next);
                  // Persist the logo immediately so it survives a refresh even if
                  // the user doesn't click "Save draft" afterwards.
                  if (!readOnly) store.updateVersion(versionId, { contentConfig: next });
                }}
                onManageCompanyLogo={onManageCompanyLogo}
              />
            )}
            {activeTab === 'branding' && (
              <Section title="Branding & style">
                <Row><FieldColor label="Primary" value={style.primaryColor} onChange={(v) => setStyle({ ...style, primaryColor: v })} disabled={readOnly} />
                  <FieldColor label="Secondary" value={style.secondaryColor} onChange={(v) => setStyle({ ...style, secondaryColor: v })} disabled={readOnly} />
                  <FieldColor label="Text" value={style.textColor} onChange={(v) => setStyle({ ...style, textColor: v })} disabled={readOnly} /></Row>
                <Row><FieldColor label="Border" value={style.borderColor} onChange={(v) => setStyle({ ...style, borderColor: v })} disabled={readOnly} />
                  <FieldColor label="Background" value={style.backgroundColor} onChange={(v) => setStyle({ ...style, backgroundColor: v })} disabled={readOnly} /></Row>
                <Row><FieldSel label="Font" value={style.fontFamily} opts={[['Inter, system-ui, sans-serif', 'Inter (sans)'], ['Georgia, serif', 'Georgia (serif)'], ['ui-monospace, monospace', 'Monospace']]} onChange={(v) => setStyle({ ...style, fontFamily: v })} disabled={readOnly} />
                  <FieldNum label="Base font size" value={style.baseFontSize} onChange={(n) => setStyle({ ...style, baseFontSize: n })} disabled={readOnly} /></Row>
                <Row><FieldSel label="Table style" value={style.tableStyle} opts={[['minimal', 'Minimal'], ['bordered', 'Bordered'], ['striped', 'Striped'], ['modern', 'Modern']]} onChange={(v) => setStyle({ ...style, tableStyle: v as InvoiceStyleConfig['tableStyle'] })} disabled={readOnly} />
                  <FieldNum label="Corner radius" value={style.borderRadius} onChange={(n) => setStyle({ ...style, borderRadius: n })} disabled={readOnly} /></Row>
                <ToggleRow label="Show table gridlines" checked={style.showTableGrid} disabled={readOnly} onChange={(v) => setStyle({ ...style, showTableGrid: v })} />
                <FieldText label="Watermark (optional)" value={style.watermark ?? ''} onChange={(v) => setStyle({ ...style, watermark: v })} disabled={readOnly} placeholder="e.g. ORIGINAL, DRAFT" />
              </Section>
            )}

            {activeTab === 'content' && (
              <Section title="Content & fields">
                <FieldText label="Invoice title" value={content.title} onChange={(v) => setContent({ ...content, title: v })} disabled={readOnly} />
                <div className="grid grid-cols-2 gap-2">
                  <ToggleRow label="Show logo" checked={content.showLogo} disabled={readOnly} onChange={(v) => setContent({ ...content, showLogo: v })} />
                  <ToggleRow label="Company address" checked={content.showCompanyAddress} disabled={readOnly} onChange={(v) => setContent({ ...content, showCompanyAddress: v })} />
                  <ToggleRow label="Customer address" checked={content.showCustomerAddress} disabled={readOnly} onChange={(v) => setContent({ ...content, showCustomerAddress: v })} />
                  <ToggleRow label="Tax details" checked={content.showTaxDetails} disabled={readOnly} onChange={(v) => setContent({ ...content, showTaxDetails: v })} />
                  <ToggleRow label="Notes" checked={content.showNotes} disabled={readOnly} onChange={(v) => setContent({ ...content, showNotes: v })} />
                  <ToggleRow label="QR code" checked={content.showQrCode} disabled={readOnly} onChange={(v) => setContent({ ...content, showQrCode: v })} />
                </div>
                <LabelEditor labels={content.customLabels} onChange={setLabel} disabled={readOnly} />
              </Section>
            )}

            {activeTab === 'columns' && (
              <Section title="Line-item columns">
                <ColumnEditor columns={layout.lineItemColumns} disabled={readOnly} onChange={(cols) => setLayout({ ...layout, lineItemColumns: cols })} />
              </Section>
            )}

            {activeTab === 'payment' && (
              <Section title="Payment details">
                <ToggleRow label="Show bank details" checked={content.showBankDetails} disabled={readOnly} onChange={(v) => setContent({ ...content, showBankDetails: v })} />
                <ToggleRow label="Show payment terms" checked={content.showPaymentTerms} disabled={readOnly} onChange={(v) => setContent({ ...content, showPaymentTerms: v })} />
                <FieldArea label="Payment instructions" value={content.paymentInstructions ?? ''} onChange={(v) => setContent({ ...content, paymentInstructions: v })} disabled={readOnly} />
                <p className="text-xs text-slate-400">Bank name, account, IBAN and SWIFT are pulled from your Company Settings at print time.</p>
              </Section>
            )}

            {activeTab === 'terms' && (
              <Section title="Terms & footer">
                <ToggleRow label="Show terms & conditions" checked={content.showTerms} disabled={readOnly} onChange={(v) => setContent({ ...content, showTerms: v })} />
                <FieldArea label="Terms text" value={content.termsText ?? ''} onChange={(v) => setContent({ ...content, termsText: v })} disabled={readOnly} />
                <FieldText label="Footer text" value={content.footerText ?? ''} onChange={(v) => setContent({ ...content, footerText: v })} disabled={readOnly} />
                <ToggleRow label="Show authorized signature" checked={content.showSignature} disabled={readOnly} onChange={(v) => setContent({ ...content, showSignature: v })} />
                <FieldText label="Signature label" value={content.customLabels.signature ?? ''} onChange={(v) => setLabel('signature', v)} disabled={readOnly} placeholder="Authorized signature" />
              </Section>
            )}

            {activeTab === 'language' && (
              <Section title="Language & direction">
                <Row><FieldSel label="Direction" value={content.direction} opts={[['ltr', 'Left-to-right'], ['rtl', 'Right-to-left (Arabic)']]} onChange={(v) => setContent({ ...content, direction: v as InvoiceContentConfig['direction'] })} disabled={readOnly} />
                  <FieldSel label="Language" value={content.language} opts={[['en', 'English'], ['ar', 'Arabic'], ['custom', 'Custom']]} onChange={(v) => setContent({ ...content, language: v })} disabled={readOnly} /></Row>
                <p className="text-xs text-slate-400">Translate any field label below; RTL mirrors the header, table and totals automatically.</p>
                <LabelEditor labels={content.customLabels} onChange={setLabel} disabled={readOnly} />
              </Section>
            )}

            {activeTab === 'preview' && previewSnapshot && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40 lg:hidden">
                <div className="origin-top scale-[0.7]"><InvoiceRenderer invoice={sample} snapshot={previewSnapshot} /></div>
              </div>
            )}
          </div>
        </div>

        {/* Live preview (wide screens) */}
        <div className="hidden min-h-0 flex-1 overflow-auto bg-slate-100 p-6 dark:bg-slate-900 lg:block">
          {previewSnapshot && <div className="mx-auto w-fit origin-top scale-[0.85] shadow-xl"><InvoiceRenderer invoice={sample} snapshot={previewSnapshot} /></div>}
        </div>
      </div>
    </div>
  );
}

/* ── small controls ── */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">{title}</h2>{children}</section>;
}
function Row({ children }: { children: React.ReactNode }) { return <div className="flex flex-wrap gap-3">{children}</div>; }
function FieldText({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  return <label className="block flex-1 text-xs text-slate-500">{label}<Input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} className="mt-1" /></label>;
}
function FieldArea({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <label className="block text-xs text-slate-500">{label}<textarea value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={3} className="focus-ring mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" /></label>;
}
function FieldNum({ label, value, onChange, disabled }: { label: string; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return <label className="block flex-1 text-xs text-slate-500">{label}<Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} className="mt-1" /></label>;
}
function FieldColor({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <label className="block flex-1 text-xs text-slate-500">{label}<Input type="color" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="mt-1 h-9 w-full" /></label>;
}
function FieldSel({ label, value, opts, onChange, disabled }: { label: string; value: string; opts: [string, string][]; onChange: (v: string) => void; disabled?: boolean }) {
  return <label className="block flex-1 text-xs text-slate-500">{label}<Select className="mt-1" options={opts.map(([value, label]) => ({ value, label }))} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} /></label>;
}
function ToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs capitalize text-slate-600 dark:border-slate-700 dark:text-slate-300">{label}<Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} /></label>;
}
function LabelEditor({ labels, onChange, disabled }: { labels: Record<string, string>; onChange: (key: string, value: string) => void; disabled?: boolean }) {
  return (
    <div>
      <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Custom field labels</p>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {LABEL_KEYS.map(({ key, fallback }) => (
          <label key={key} className="block text-[11px] text-slate-400">{fallback}
            <Input value={labels[key] ?? ''} onChange={(e) => onChange(key, e.target.value)} disabled={disabled} placeholder={fallback} className="mt-0.5 h-8 text-xs" />
          </label>
        ))}
      </div>
    </div>
  );
}
function ColumnEditor({ columns, onChange, disabled }: { columns: InvoiceColumnConfig[]; onChange: (c: InvoiceColumnConfig[]) => void; disabled?: boolean }) {
  const ordered = [...columns].sort((a, b) => a.order - b.order);
  const move = (i: number, d: -1 | 1): void => {
    const j = i + d; if (j < 0 || j >= ordered.length) return;
    const next = [...ordered]; [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next.map((c, idx) => ({ ...c, order: idx + 1 })));
  };
  const patch = (field: string, p: Partial<InvoiceColumnConfig>): void => onChange(columns.map((c) => (c.field === field ? { ...c, ...p } : c)));
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {ordered.map((c, i) => (
        <li key={c.field} className="flex items-center gap-2 px-2 py-1.5 text-xs">
          <input type="checkbox" checked={c.visible} disabled={disabled} onChange={(e) => patch(c.field, { visible: e.target.checked })} />
          <Input value={c.label} onChange={(e) => patch(c.field, { label: e.target.value })} disabled={disabled} className="h-7 flex-1 text-xs" />
          <Input type="number" value={c.width ?? 0} onChange={(e) => patch(c.field, { width: Number(e.target.value) || undefined })} disabled={disabled} className="h-7 w-16 text-xs" placeholder="w" />
          <button disabled={disabled || i === 0} onClick={() => move(i, -1)} className="px-1 disabled:opacity-30" aria-label="Move up">↑</button>
          <button disabled={disabled || i === ordered.length - 1} onClick={() => move(i, 1)} className="px-1 disabled:opacity-30" aria-label="Move down">↓</button>
        </li>
      ))}
    </ul>
  );
}

function structuredCopy<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
