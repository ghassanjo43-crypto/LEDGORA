import { useRef, useState } from 'react';
import { Upload, RefreshCw, Trash2, ImageOff, Building2, AlertTriangle } from 'lucide-react';
import type { InvoiceLogoConfig, LogoFit, LogoMode, LogoPosition } from '@/types/invoice';
import {
  DEFAULT_LOGO_CONFIG,
  LOGO_ACCEPT_ATTR,
  LOGO_SIZE_PRESETS,
  compressImageDataUrl,
  measureImage,
  readFileAsDataUrl,
  validateLogoFile,
} from '@/lib/invoiceLogo';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { LogoImage } from './LogoImage';

interface Props {
  value: InvoiceLogoConfig;
  companyDefaultLogoUrl?: string;
  disabled?: boolean;
  onChange: (next: InvoiceLogoConfig) => void;
  onManageCompanyLogo: () => void;
}

const POSITIONS: { id: LogoPosition; label: string }[] = [
  { id: 'top-left', label: 'Left' }, { id: 'top-center', label: 'Center' }, { id: 'top-right', label: 'Right' },
];

/** The prominent "Company Logo" control at the top of the Branding tab. */
export function LogoControl({ value, companyDefaultLogoUrl, disabled, onChange, onManageCompanyLogo }: Props) {
  const cfg = value ?? DEFAULT_LOGO_CONFIG;
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const previewUrl = cfg.mode === 'hidden' ? undefined : cfg.mode === 'custom' ? cfg.customLogoUrl : companyDefaultLogoUrl;
  const sizePreset = LOGO_SIZE_PRESETS.find((p) => p.maxWidth === cfg.maxWidth && p.maxHeight === cfg.maxHeight)?.id ?? 'custom';

  const patch = (p: Partial<InvoiceLogoConfig>): void => onChange({ ...cfg, ...p });

  const pickFile = (): void => { setError(null); fileRef.current?.click(); };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const v = validateLogoFile(file);
    if (!v.ok) { setError(v.error ?? 'Invalid file.'); return; }
    setBusy(true);
    try {
      const rawUrl = await readFileAsDataUrl(file);
      const dims = await measureImage(rawUrl).catch(() => { throw new Error('The image could not be read — it may be corrupt.'); });
      if (dims.width && dims.width < 48) { setError('That image is very small — use at least 48px wide for a crisp logo.'); setBusy(false); return; }
      // Downscale/compress so the persisted data URL fits in LocalStorage.
      const dataUrl = await compressImageDataUrl(rawUrl);
      setError(null);
      onChange({ ...cfg, mode: 'custom', customLogoUrl: dataUrl, fileName: file.name, mimeType: file.type, width: dims.width || undefined, height: dims.height || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">Company Logo</h2>
        <span className="text-[11px] text-slate-400">Logo source: <span className="font-medium text-slate-600 dark:text-slate-300">{cfg.mode === 'custom' ? 'Custom template logo' : cfg.mode === 'hidden' ? 'Hidden' : 'Company default'}</span></span>
      </div>

      {/* Source options */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {([['entity-default', 'Company default logo'], ['custom', 'Custom logo for this template'], ['hidden', 'Hide logo']] as [LogoMode, string][]).map(([mode, label]) => (
          <label key={mode} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs', cfg.mode === mode ? 'border-brand-400 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300', disabled && 'opacity-60')}>
            <input type="radio" name="logo-mode" checked={cfg.mode === mode} disabled={disabled} onChange={() => patch({ mode })} />
            {label}
          </label>
        ))}
      </div>

      {/* Preview + upload actions */}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <div className="flex h-24 w-44 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40">
          {cfg.mode === 'hidden' ? (
            <span className="flex flex-col items-center gap-1 text-xs text-slate-400"><ImageOff className="h-5 w-5" /> Logo hidden</span>
          ) : previewUrl ? (
            <LogoImage url={previewUrl} alt="Logo preview" style={{ maxWidth: cfg.maxWidth, maxHeight: cfg.maxHeight, objectFit: cfg.fit }} />
          ) : (
            <span className="flex flex-col items-center gap-1 text-center text-[11px] text-slate-400"><ImageOff className="h-5 w-5" /> No company logo<br />has been uploaded.</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {cfg.mode !== 'hidden' && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={pickFile}>
                <Upload className="h-4 w-4" /> {cfg.mode === 'custom' && cfg.customLogoUrl ? 'Replace logo' : 'Upload logo'}
              </Button>
              {cfg.mode === 'custom' && cfg.customLogoUrl && (
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => patch({ mode: 'entity-default', customLogoUrl: undefined, fileName: undefined, mimeType: undefined })}>
                  <Trash2 className="h-4 w-4" /> Remove custom logo
                </Button>
              )}
              {cfg.mode === 'entity-default' && (
                <Button type="button" variant="ghost" size="sm" onClick={onManageCompanyLogo}>
                  <Building2 className="h-4 w-4" /> Manage company logo
                </Button>
              )}
            </div>
          )}
          {cfg.mode === 'entity-default' && !companyDefaultLogoUrl && (
            <p className="text-[11px] text-slate-500">No company logo yet — <button type="button" className="text-brand-600 underline" onClick={pickFile}>upload one for this template</button>, or set a company logo in Settings.</p>
          )}
          {cfg.mode === 'entity-default' && companyDefaultLogoUrl && <p className="text-[11px] text-slate-400">Using logo from Settings → Company Profile.</p>}
          {cfg.fileName && cfg.mode === 'custom' && <p className="text-[11px] text-slate-400">{cfg.fileName}</p>}
          <RefreshCw className={cn('h-3.5 w-3.5 text-brand-500', busy ? 'animate-spin' : 'hidden')} />
        </div>
        <input ref={fileRef} type="file" accept={LOGO_ACCEPT_ATTR} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>

      {error && <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400"><AlertTriangle className="h-3.5 w-3.5" /> {error}</p>}

      {/* Position / size / fit */}
      {cfg.mode !== 'hidden' && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Position</p>
            <div className="mt-1 flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
              {POSITIONS.map((p) => (
                <button key={p.id} type="button" disabled={disabled} onClick={() => patch({ position: p.id })} className={cn('flex-1 rounded-md px-2 py-1.5 font-medium', cfg.position === p.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500')}>{p.label}</button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Size</p>
            <div className="mt-1 flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
              {[...LOGO_SIZE_PRESETS, { id: 'custom' as const, label: 'Custom', maxWidth: 0, maxHeight: 0 }].map((p) => (
                <button key={p.id} type="button" disabled={disabled} onClick={() => p.id !== 'custom' && patch({ maxWidth: p.maxWidth, maxHeight: p.maxHeight })} className={cn('flex-1 rounded-md px-2 py-1.5 font-medium', sizePreset === p.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500')}>{p.label}</button>
              ))}
            </div>
            {sizePreset === 'custom' && (
              <div className="mt-1 flex gap-1">
                <Input type="number" value={cfg.maxWidth} disabled={disabled} onChange={(e) => patch({ maxWidth: Number(e.target.value) || 0 })} className="h-8 text-xs" placeholder="max W" />
                <Input type="number" value={cfg.maxHeight} disabled={disabled} onChange={(e) => patch({ maxHeight: Number(e.target.value) || 0 })} className="h-8 text-xs" placeholder="max H" />
              </div>
            )}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Image fit</p>
            <div className="mt-1 flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
              {(['contain', 'cover'] as LogoFit[]).map((f) => (
                <button key={f} type="button" disabled={disabled} onClick={() => patch({ fit: f })} className={cn('flex-1 rounded-md px-2 py-1.5 font-medium capitalize', cfg.fit === f ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500')}>{f}</button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-slate-400">Aspect ratio is always preserved.</p>
          </div>
        </div>
      )}
    </section>
  );
}
