import { describe, it, expect } from 'vitest';
import { documentsToPresent, evaluateAcceptance } from './legalAcceptance';
import type { LegalDocument } from '@/content/legal/types';
import {
  ALL_LEGAL_DOCUMENTS,
  LEGAL_COUNTRIES,
  addendumFor,
  canonicalText,
  documentHash,
  isLegalCountry,
  masterTerms,
  publicationReadiness,
  resolveApplicableDocuments,
  unresolvedItems,
} from './legalDocuments';
import {
  LEGAL_PATHS,
  PUBLIC_PATHS,
  ROUTES,
  preAcceptanceAllowsPath,
  preAcceptanceAllowsView,
  surfaceOf,
} from './accessControl';

/* ══ The applicable addendum ═══════════════════════════════════════════════ */

describe('which addendum applies', () => {
  it('gives each country its own addendum', () => {
    expect(resolveApplicableDocuments('AE').addendum.id).toBe('addendum-ae');
    expect(resolveApplicableDocuments('JO').addendum.id).toBe('addendum-jo');
    expect(resolveApplicableDocuments('SA').addendum.id).toBe('addendum-sa');
  });

  it('gives every country the SAME Master Terms', () => {
    const masters = LEGAL_COUNTRIES.map((c) => resolveApplicableDocuments(c).master.id);
    expect(new Set(masters)).toEqual(new Set(['master-terms']));
  });

  it('cannot be influenced by anything except the registered country', () => {
    /*
     * The guarantee is structural, not behavioural: `resolveApplicableDocuments`
     * takes one argument and it is the registered legal country. There is no
     * parameter through which a locale, a timezone, an IP address or a currency
     * could reach the decision, so there is nothing to ignore.
     */
    expect(resolveApplicableDocuments.length).toBe(1);
    /* Same country in, same addendum out — every time, whatever else changes. */
    for (const country of LEGAL_COUNTRIES) {
      expect(resolveApplicableDocuments(country).addendum.id)
        .toBe(resolveApplicableDocuments(country).addendum.id);
      expect(resolveApplicableDocuments(country).addendum.country).toBe(country);
    }
  });

  it('refuses anything that is not one of the three supported codes', () => {
    for (const bad of ['ae', 'UAE', 'ARE', 'US', 'GB', '', ' AE', null, undefined, 42, {}]) {
      expect(isLegalCountry(bad), `${String(bad)} must not be a legal country`).toBe(false);
    }
    for (const good of LEGAL_COUNTRIES) expect(isLegalCountry(good)).toBe(true);
  });
});

/* ══ Acceptance evaluation ═════════════════════════════════════════════════ */

describe('evaluating what a user still owes', () => {
  it('requires nothing while the documents are unapproved drafts', () => {
    /*
     * The current state. Requiring acceptance of a draft would record consent
     * to text containing `[UNRESOLVED]` placeholders; refusing entry would turn
     * an unfinished legal review into an outage. Neither is acceptable, so the
     * gate is dormant — and it arms itself when the drafts are approved.
     */
    for (const country of LEGAL_COUNTRIES) {
      const result = evaluateAcceptance({ legalCountry: country, organizationAcceptances: [], individualAcknowledgments: [] });
      expect(result.status).toBe('not-required-documents-not-ready');
      expect(result.blocksOperationalAccess).toBe(false);
      expect(result.explanation).toMatch(/not yet approved/i);
    }
  });

  it('asks for the country first when the organization has none', () => {
    const result = evaluateAcceptance({ legalCountry: null, organizationAcceptances: [], individualAcknowledgments: [] });
    expect(result.status).toBe('country-required');
    expect(result.country).toBeNull();
    /* Not a lockout: nobody asked them the question yet. */
    expect(result.blocksOperationalAccess).toBe(false);
  });

  it('does not treat a free-text country as a legal country', () => {
    for (const value of ['United Arab Emirates', 'Jordan', 'Dubai', 'KSA']) {
      expect(evaluateAcceptance({ legalCountry: value, organizationAcceptances: [], individualAcknowledgments: [] }).status).toBe('country-required');
    }
  });
});

/* ══ The same evaluation once the documents are approved ═══════════════════ */

describe('once the documents are approved (simulated)', () => {
  /*
   * The drafts cannot be accepted, so the behaviour that will matter at launch
   * is exercised against approved COPIES. This keeps the real documents honest
   * — they stay unapproved until counsel says otherwise — while still proving
   * the logic that switches on when they are.
   */
  const approve = (doc: LegalDocument): LegalDocument => {
    /*
     * Everything publication requires, in order: settle the placeholders, date
     * it, give it a real version, get both approvals — and pin the hash LAST,
     * because the digest covers the version and the effective date too.
     */
    const settled: LegalDocument = {
      ...doc,
      counselApproved: true,
      publicationApproved: true,
      effectiveDate: '2026-09-01',
      version: doc.version.replace(/-draft$/, ''),
      sections: doc.sections.map((s) => ({
        ...s,
        blocks: s.blocks.filter((b) => b.kind !== 'unresolved'),
      })),
    };
    return { ...settled, expectedContentHash: documentHash(settled) };
  };

  it('is exactly the drafts that block readiness, and nothing else', () => {
    for (const document of ALL_LEGAL_DOCUMENTS) {
      const readiness = publicationReadiness(document);
      expect(readiness.ready).toBe(false);
      expect(readiness.counselApproved).toBe(false);
      expect(readiness.unresolvedCount).toBeGreaterThan(0);

      const ready = publicationReadiness(approve(document));
      expect(ready.ready, `${document.title}: ${ready.reasons.join(' ')}`).toBe(true);
      expect(ready.unresolvedCount).toBe(0);
    }
  });

  it('refuses to publish an approved document whose text has since changed', () => {
    const approved = approve(masterTerms());
    expect(publicationReadiness(approved).ready).toBe(true);

    /* One word edited after approval — the pinned hash must catch it. */
    const tampered: LegalDocument = {
      ...approved,
      sections: approved.sections.map((s, i) =>
        i === 0
          ? { ...s, blocks: s.blocks.map((b) => (b.kind === 'paragraph' ? { ...b, text: `${b.text} Extra.` } : b)) }
          : s),
    };
    const readiness = publicationReadiness(tampered);
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons.join(' ')).toMatch(/does not match its pinned content hash/);
  });

  it('needs BOTH approvals — counsel alone is not enough to publish', () => {
    const approved = approve(masterTerms());
    const counselOnly = { ...approved, publicationApproved: false };
    expect(publicationReadiness(counselOnly).ready).toBe(false);
    expect(publicationReadiness(counselOnly).reasons.join(' ')).toMatch(/not been approved for publication/);

    const publicationOnly = { ...approved, counselApproved: false };
    expect(publicationReadiness(publicationOnly).ready).toBe(false);
    expect(publicationReadiness(publicationOnly).reasons.join(' ')).toMatch(/not been approved by counsel/);
  });
});

/* ══ What is presented is what is recorded ═════════════════════════════════ */

describe('a user can only accept what they were shown', () => {
  it('presents exactly the master plus the one applicable addendum', () => {
    for (const country of LEGAL_COUNTRIES) {
      const presented = documentsToPresent(country);
      expect(presented).toHaveLength(2);
      expect(presented[0]!.documentId).toBe('master-terms');
      expect(presented[1]!.documentId).toBe(addendumFor(country).id);
      /* Never another country's addendum. */
      const others = LEGAL_COUNTRIES.filter((c) => c !== country).map((c) => addendumFor(c).id);
      expect(presented.map((p) => p.documentId).some((id) => others.includes(id))).toBe(false);
    }
  });

  it('presents the same version and hash that an acceptance would record', () => {
    for (const country of LEGAL_COUNTRIES) {
      const { master, addendum } = resolveApplicableDocuments(country);
      const presented = documentsToPresent(country);
      expect(presented[0]!.version).toBe(master.version);
      expect(presented[0]!.contentHash).toBe(documentHash(master));
      expect(presented[1]!.version).toBe(addendum.version);
      expect(presented[1]!.contentHash).toBe(documentHash(addendum));
    }
  });

  it('records BOTH documents — never the master alone', () => {
    const presented = documentsToPresent('JO');
    expect(presented.map((p) => p.documentId).sort()).toEqual(['addendum-jo', 'master-terms']);
  });
});

/* ══ Hashing ═══════════════════════════════════════════════════════════════ */

describe('document hashing', () => {
  it('gives every document a distinct, stable, verifiable digest', () => {
    const hashes = ALL_LEGAL_DOCUMENTS.map(documentHash);
    expect(new Set(hashes).size).toBe(ALL_LEGAL_DOCUMENTS.length);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    /* Stable across calls — an acceptance recorded now must verify later. */
    expect(ALL_LEGAL_DOCUMENTS.map(documentHash)).toEqual(hashes);
  });

  it('changes when a single word changes, and not otherwise', () => {
    const master = masterTerms();
    const before = documentHash(master);
    const edited = {
      ...master,
      sections: master.sections.map((s, i) =>
        i === 0
          ? { ...s, blocks: s.blocks.map((b) => (b.kind === 'paragraph' ? { ...b, text: `${b.text}.` } : b)) }
          : s),
    };
    expect(documentHash(edited)).not.toBe(before);
    /* Re-deriving the same document must not move the hash. */
    expect(documentHash({ ...master, sections: [...master.sections] })).toBe(before);
  });

  it('cannot be forged by content that imitates a section boundary', () => {
    const a = { ...masterTerms(), version: '1.0', title: 'A' };
    const b = { ...masterTerms(), version: '1.0', title: 'A' };
    expect(canonicalText(a)).toBe(canonicalText(b));
    expect(canonicalText({ ...a, version: '1.0.0' })).not.toBe(canonicalText(a));
  });
});

/* ══ Public access to the documents ════════════════════════════════════════ */

describe('reaching the legal documents', () => {
  it('lets a signed-out visitor open all four', () => {
    for (const path of [ROUTES.terms, ROUTES.termsUae, ROUTES.termsJordan, ROUTES.termsSaudi]) {
      expect(PUBLIC_PATHS.includes(path), `${path} must be public`).toBe(true);
    }
  });

  it('classifies every legal path onto the legal surface', () => {
    for (const path of [...LEGAL_PATHS, ROUTES.termsAcceptance]) {
      expect(surfaceOf(path)).toBe('legal');
    }
  });

  it('keeps the terms reachable from the acceptance screen, so there is no loop', () => {
    for (const path of LEGAL_PATHS) expect(preAcceptanceAllowsPath(path)).toBe(true);
    expect(preAcceptanceAllowsPath(ROUTES.termsAcceptance)).toBe(true);
  });
});

/* ══ What a user may still do before accepting ═════════════════════════════ */

describe('access while acceptance is outstanding', () => {
  it('keeps security, billing, subscription, support and profile open', () => {
    for (const path of [
      ROUTES.accountSecurity, ROUTES.changePassword,
      ROUTES.billingPayment, ROUTES.billingRenew,
      ROUTES.subscriptionStatus, ROUTES.subscriptionSuspended,
      ROUTES.support, ROUTES.profile, ROUTES.terms,
    ]) {
      expect(preAcceptanceAllowsPath(path), `${path} must stay reachable`).toBe(true);
    }
  });

  it('keeps data export open — leaving must not require consenting to stay', () => {
    expect(preAcceptanceAllowsView('import-export')).toBe(true);
  });

  it('blocks the operational accounting modules', () => {
    expect(preAcceptanceAllowsPath(ROUTES.appDashboard)).toBe(false);
    expect(surfaceOf(ROUTES.appDashboard)).toBe('app');
    for (const view of ['dashboard', 'journal', 'invoices', 'bills', 'general-ledger', 'trial-balance']) {
      expect(preAcceptanceAllowsView(view), `${view} must be blocked`).toBe(false);
    }
  });
});

/* ══ The drafts themselves ═════════════════════════════════════════════════ */

describe('the drafts as published for review', () => {
  it('are all unapproved, undated and carry their unresolved items', () => {
    for (const document of ALL_LEGAL_DOCUMENTS) {
      expect(document.counselApproved).toBe(false);
      expect(document.effectiveDate).toBe('not-yet-effective');
      expect(document.version).toMatch(/-draft$/);
      expect(unresolvedItems(document).length).toBeGreaterThan(0);
      expect(document.reviewRequired.length).toBeGreaterThan(0);
    }
  });

  it('are English, with no interface-language change implied', () => {
    for (const document of ALL_LEGAL_DOCUMENTS) expect(document.language).toBe('en');
  });

  it('never claim a tax-authority integration that does not exist', () => {
    const jordan = canonicalText(addendumFor('JO'));
    expect(jordan).toMatch(/does NOT submit, clear or transmit invoices to JOFOTARA/);
    const saudi = canonicalText(addendumFor('SA'));
    expect(saudi).toMatch(/provides NO ZATCA e-invoicing capability/);
    expect(saudi).toMatch(/make no claim of ZATCA compliance or certification/);
  });

  it('preserve mandatory local rights above the governing-law clause', () => {
    const master = canonicalText(masterTerms());
    expect(master).toMatch(/cannot lawfully be excluded or limited by agreement/);
    expect(master).toMatch(/prevails over any other provision of these Terms, including any governing-law/);
    for (const country of LEGAL_COUNTRIES) {
      expect(canonicalText(addendumFor(country))).toMatch(/cannot be excluded by agreement/);
    }
  });

  it('leave the provider identity and forum unresolved rather than invented', () => {
    const uae = canonicalText(addendumFor('AE'));
    expect(uae).toMatch(/UNRESOLVED — free zone authority, trade licence number/);
    expect(uae).toMatch(/UNRESOLVED — governing Emirate and competent court/);
    /* No invented specifics. */
    expect(uae).not.toMatch(/JAFZA|DMCC|RAKEZ|Dubai Courts|DIFC Courts|ADGM/);
  });
});
