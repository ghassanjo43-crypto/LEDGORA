/**
 * What the durable Fixed Assets module does not do yet, said plainly.
 *
 * ══ Why this is a component and not a paragraph in each page ═════════════════
 *
 * A bookkeeper who opens the asset register looking for depreciation and finds
 * only an empty screen concludes the feature is broken, or that their data is
 * missing. Both conclusions cost somebody an afternoon. Saying which decision
 * has not been made — and that nothing has been lost — is the difference
 * between an unfinished module and one that looks wrong.
 *
 * The sentences come from the SERVER's own capability payload when it has
 * answered, so the screen and the API cannot drift apart about which workflows
 * exist. The constants are the fallback for a screen that has not loaded them
 * yet, and they say the same thing.
 */
import type { FixedAssetCapabilities } from '@/services/api/fixedAssetsApi';
import {
  BILL_ACQUISITION_UNSUPPORTED,
  CAPITALIZATION_UNSUPPORTED,
  DEPRECIATION_UNSUPPORTED,
  DISPOSAL_UNSUPPORTED,
  IMPAIRMENT_UNSUPPORTED,
  REVALUATION_UNSUPPORTED,
} from '@/services/fixedAssets/fixedAssetsBackend';
import { Card, CardBody } from '@/components/ui/Card';

interface DeferredItem {
  key: string;
  title: string;
  body: string;
}

/**
 * The server's wording where it has it, ours where it has not.
 *
 * Keyed to the capability payload rather than hard-coded, so an entry
 * disappears from this list the moment F2 turns the capability on — rather
 * than staying on screen telling a subscriber that a feature they are using
 * does not exist.
 */
export function deferredItems(capabilities: FixedAssetCapabilities | null): DeferredItem[] {
  const said = capabilities?.deferred ?? {};
  const rows: Array<[string, string, boolean, string]> = [
    [
      'capitalization',
      'Capitalisation and acquisition cost',
      capabilities ? !capabilities.capitalization : true,
      said.capitalization ?? CAPITALIZATION_UNSUPPORTED,
    ],
    [
      'depreciation',
      'Depreciation schedules, runs and posting',
      capabilities ? !capabilities.depreciationPosting : true,
      said.depreciation ?? DEPRECIATION_UNSUPPORTED,
    ],
    [
      'disposal',
      'Disposal, sale, write-off and retirement',
      capabilities ? !capabilities.disposal : true,
      said.disposal ?? DISPOSAL_UNSUPPORTED,
    ],
    [
      'impairment',
      'Impairment and impairment reversal',
      capabilities ? !capabilities.impairment : true,
      said.impairment ?? IMPAIRMENT_UNSUPPORTED,
    ],
    [
      'revaluation',
      'Revaluation',
      capabilities ? !capabilities.revaluation : true,
      said.revaluation ?? REVALUATION_UNSUPPORTED,
    ],
    [
      'billAcquisition',
      'Buying an asset on a supplier bill',
      capabilities ? !capabilities.billAcquisition : true,
      said.billAcquisition ?? BILL_ACQUISITION_UNSUPPORTED,
    ],
  ];
  return rows
    .filter(([, , deferred]) => deferred)
    .map(([key, title, , body]) => ({ key, title, body }));
}

export function DeferredAccountingPanel({
  capabilities,
  heading = 'Accounting not yet available',
}: {
  capabilities: FixedAssetCapabilities | null;
  heading?: string;
}) {
  const items = deferredItems(capabilities);
  if (items.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{heading}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            This release records the asset register and the depreciation policy that will apply to
            it. It posts no journal of any kind, so the figures below do not exist yet — they are
            not missing, and nothing you enter here is lost when they arrive.
          </p>
        </div>
        <dl className="space-y-2.5">
          {items.map((item) => (
            <div key={item.key} className="border-t border-slate-100 pt-2.5 dark:border-slate-800">
              <dt className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {item.title}
              </dt>
              <dd className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{item.body}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
