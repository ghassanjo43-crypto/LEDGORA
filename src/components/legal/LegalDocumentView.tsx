/**
 * One legal document, rendered from its data.
 *
 * The text comes from the same structure `documentHash` digests, so what a
 * reader sees and what an acceptance record pins are the same words by
 * construction — a restyle of this component cannot change the hash, and an
 * edit to the words cannot leave it unchanged.
 *
 * `unresolved` blocks are rendered as a visibly distinct call-out rather than
 * as prose. A placeholder that reads like a term is the one presentation
 * failure this component must not have.
 */
import type { LegalDocument } from '@/content/legal/types';
import { documentHash, publicationReadiness } from '@/lib/legalDocuments';
import { Badge } from '@/components/ui/Badge';

interface Props {
  document: LegalDocument;
  /** Show the content hash and readiness detail. For review surfaces. */
  showProvenance?: boolean;
}

export function LegalDocumentView({ document, showProvenance }: Props) {
  const readiness = publicationReadiness(document);
  const hash = documentHash(document);

  return (
    <article className="space-y-6" aria-labelledby={`legal-${document.id}`}>
      <header className="space-y-2 border-b border-slate-200 pb-4 dark:border-slate-800">
        <h1 id={`legal-${document.id}`} className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {document.title}
        </h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex gap-1.5">
            <dt className="font-semibold">Version</dt>
            <dd className="font-mono">{document.version}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-semibold">Effective</dt>
            <dd className="font-mono">
              {document.effectiveDate === 'not-yet-effective' ? 'not yet in force' : document.effectiveDate}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-semibold">Language</dt>
            <dd>English</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Status</dt>
            <dd>
              <Badge tone={readiness.ready ? 'green' : 'amber'}>
                {readiness.ready ? 'in force' : 'draft — not in force'}
              </Badge>
            </dd>
          </div>
        </dl>
        {showProvenance && (
          <p className="break-all font-mono text-[11px] text-slate-400">
            SHA-256 {hash}
          </p>
        )}
      </header>

      {showProvenance && !readiness.ready && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <h2 className="font-semibold">Why this is not published</h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          <p className="mt-2">
            <span className="font-semibold">Review required: </span>{document.reviewRequired}
          </p>
        </section>
      )}

      {document.sections.map((section) => (
        <section key={section.number} className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            <span className="mr-2 font-mono text-slate-400">{section.number}</span>
            {section.heading}
          </h2>
          {section.blocks.map((block, index) => {
            if (block.kind === 'paragraph') {
              return (
                <p key={index} className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                  {block.text}
                </p>
              );
            }
            if (block.kind === 'list') {
              return (
                <ul key={index} className="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
                  {block.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              );
            }
            return (
              <p
                key={index}
                data-testid="legal-unresolved"
                className="rounded-lg border border-dashed border-amber-400 bg-amber-50/70 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200"
              >
                {block.text}
              </p>
            );
          })}
        </section>
      ))}
    </article>
  );
}
