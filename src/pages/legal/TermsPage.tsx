/**
 * The public Terms page, and the draft preview that stands in for it.
 *
 * ── Two different pages behind one route ─────────────────────────────────────
 *
 * `/terms` and the three addendum paths serve the PUBLISHED text to anybody,
 * signed in or not. While a document is still a draft the same route serves a
 * short "not yet published" notice instead of the text — never the placeholders.
 *
 * A viewer entitled to preview drafts (`canPreviewLegalDrafts`) sees the draft
 * behind an unmissable banner. That is a read-only surface: it records nothing
 * and gates nothing, because acceptance keys off `publicationReadiness`, which
 * previewing does not change.
 */
import { useMemo } from 'react';
import type { LegalCountryCode, LegalDocument } from '@/content/legal/types';
import {
  LEGAL_COUNTRIES,
  LEGAL_COUNTRY_NAMES,
  addendumFor,
  isPubliclyPublishable,
  masterTerms,
} from '@/lib/legalDocuments';
import { DRAFT_PREVIEW_NOTICE, canPreviewLegalDrafts } from '@/lib/legalPreview';
import { ROUTES } from '@/lib/accessControl';
import { useRouterStore } from '@/store/routerStore';
import { Card, CardBody } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { cn } from '@/lib/utils';

const PATH_BY_COUNTRY: Record<LegalCountryCode, string> = {
  AE: ROUTES.termsUae,
  JO: ROUTES.termsJordan,
  SA: ROUTES.termsSaudi,
};

/** Which document this path asks for. Path-based, never a query parameter. */
function documentForPath(path: string): { document: LegalDocument; country: LegalCountryCode | null } {
  for (const country of LEGAL_COUNTRIES) {
    if (path === PATH_BY_COUNTRY[country]) return { document: addendumFor(country), country };
  }
  return { document: masterTerms(), country: null };
}

export function TermsPage() {
  const path = useRouterStore((s) => s.path);
  const navigate = useRouterStore((s) => s.navigate);
  const { document, country } = useMemo(() => documentForPath(path), [path]);

  const published = isPubliclyPublishable(document);
  const mayPreview = canPreviewLegalDrafts();

  const link = (target: string, label: string, active: boolean) => (
    <a
      key={target}
      href={target}
      onClick={(e) => { e.preventDefault(); navigate(target); }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'focus-ring rounded-lg px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-slate-900 font-medium text-white dark:bg-slate-100 dark:text-slate-900'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
      )}
    >
      {label}
    </a>
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <nav aria-label="Ledgora legal documents" className="mb-6 flex flex-wrap gap-1.5">
        {link(ROUTES.terms, 'Master Terms', country === null)}
        {LEGAL_COUNTRIES.map((c) =>
          link(PATH_BY_COUNTRY[c], `${LEGAL_COUNTRY_NAMES[c]} Addendum`, country === c))}
      </nav>

      <p className="mb-6 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The Ledgora Master Terms and Conditions apply to every customer. The Country Addendum for the
        country your organization is legally registered in supplements them, and prevails where the
        mandatory law of that country requires it. Your organization&rsquo;s registered country is
        selected by an owner — it is never inferred from your location, language or currency.
      </p>

      {published ? (
        <Card><CardBody><LegalDocumentView document={document} /></CardBody></Card>
      ) : mayPreview ? (
        <>
          <Alert variant="warning" title="Draft — not in force">
            {DRAFT_PREVIEW_NOTICE}
          </Alert>
          <div className="mt-4">
            <Card><CardBody><LegalDocumentView document={document} showProvenance /></CardBody></Card>
          </div>
        </>
      ) : (
        <Card>
          <CardBody>
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {document.title}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              This document has not been published yet. It is being prepared and reviewed, and no
              version of it is currently in force. Nothing is being asked of you, and no acceptance is
              recorded.
            </p>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              If you need the terms that govern an existing subscription, please contact support.
            </p>
          </CardBody>
        </Card>
      )}
    </main>
  );
}
