import { useRef, useState } from 'react';
import type { ImportResult } from '@/types';
import { useStore } from '@/store/useStore';
import {
  exportToCsv,
  exportToJson,
  importFromCsv,
  importFromJson,
} from '@/lib/importExport';
import { downloadFile } from '@/lib/utils';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/icons';
import { ValidationPanel } from '@/components/validation/ValidationPanel';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export function ImportExportPanel() {
  const accounts = useStore((s) => s.accounts);
  const replaceAll = useStore((s) => s.replaceAll);
  const companyName = useStore((s) => s.settings.companyName);
  const { notify } = useToast();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [confirmReplace, setConfirmReplace] = useState(false);

  const slug = companyName.replace(/[^a-z0-9]+/giu, '-').toLowerCase() || 'chart';
  const stamp = new Date().toISOString().slice(0, 10);

  const handleExportJson = (): void => {
    downloadFile(`${slug}-coa-${stamp}.json`, exportToJson(accounts), 'application/json');
    notify('Exported chart of accounts as JSON.', 'success');
  };

  const handleExportCsv = (): void => {
    downloadFile(`${slug}-coa-${stamp}.csv`, exportToCsv(accounts), 'text/csv');
    notify('Exported chart of accounts as CSV.', 'success');
  };

  const handleFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith('.json');
    const result = isJson ? importFromJson(text) : importFromCsv(text);
    setFileName(file.name);
    setPreview(result);
    if (result.accounts.length === 0) {
      notify('Import failed — see the errors below.', 'error');
    } else if (!result.ok) {
      notify('Parsed with validation errors. Review before applying.', 'warning');
    } else {
      notify(`Parsed ${result.accounts.length} accounts. Ready to apply.`, 'success');
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  const applyImport = (): void => {
    if (!preview) return;
    replaceAll(preview.accounts);
    notify(`Imported ${preview.accounts.length} accounts.`, 'success');
    setPreview(null);
    setFileName('');
    setConfirmReplace(false);
  };

  const errorCount = preview?.issues.filter((i) => i.severity === 'error').length ?? 0;
  const warningCount = preview?.issues.filter((i) => i.severity === 'warning').length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Export" description="Download the current chart of accounts." />
        <CardBody className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Exports include every account — active and inactive — so historical
            records remain complete.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleExportJson}>
              <Icon.Download className="h-4 w-4" /> Export JSON
            </Button>
            <Button variant="secondary" onClick={handleExportCsv}>
              <Icon.Download className="h-4 w-4" /> Export CSV
            </Button>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
            {accounts.length} accounts will be exported.
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Import" description="Load accounts from JSON or CSV." />
        <CardBody className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={onInputChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="focus-ring flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40 dark:border-slate-700 dark:bg-slate-800/40 dark:hover:border-brand-500"
          >
            <Icon.Upload className="h-6 w-6 text-slate-400" />
            <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
              Click to choose a .json or .csv file
            </span>
            <span className="text-xs text-slate-400">
              The file is validated before anything is saved.
            </span>
          </button>
          {fileName && (
            <p className="text-xs text-slate-500">
              Selected file: <span className="font-medium">{fileName}</span>
            </p>
          )}
        </CardBody>
      </Card>

      {preview && (
        <Card className="lg:col-span-2">
          <CardHeader
            title="Import preview"
            description="Review parsing and validation before applying."
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={errorCount ? 'red' : 'green'}>{errorCount} errors</Badge>
                <Badge tone={warningCount ? 'amber' : 'slate'}>{warningCount} warnings</Badge>
                <Button variant="outline" size="sm" onClick={() => setPreview(null)}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  disabled={preview.accounts.length === 0}
                  onClick={() => setConfirmReplace(true)}
                >
                  Apply import
                </Button>
              </div>
            }
          />
          <CardBody className="space-y-3">
            {preview.accounts.length > 0 ? (
              <Alert variant={preview.ok ? 'success' : 'warning'}>
                Parsed <strong>{preview.accounts.length}</strong> accounts.{' '}
                {preview.ok
                  ? 'No blocking errors — safe to apply.'
                  : 'Applying is allowed, but resolve errors afterwards for a clean chart.'}
              </Alert>
            ) : (
              <Alert variant="error" title="Nothing to import">
                The file could not be parsed into accounts.
              </Alert>
            )}
            <ValidationPanel issues={preview.issues} emptyMessage="The imported file passed all checks." />
          </CardBody>
        </Card>
      )}

      <ConfirmDialog
        open={confirmReplace}
        title="Replace chart of accounts?"
        message={`This replaces all ${accounts.length} current accounts with the ${preview?.accounts.length ?? 0} imported accounts. This cannot be undone.`}
        confirmLabel="Replace"
        destructive
        onConfirm={applyImport}
        onCancel={() => setConfirmReplace(false)}
      />
    </div>
  );
}
