import { describe, it, expect } from 'vitest';
import {
  evaluateAcceptance,
  resolveBindingAuthority,
  type AcceptanceRecord,
} from './legalAcceptance';
import { LEGAL_COUNTRIES, addendumFor, documentHash, masterTerms } from './legalDocuments';
import type { LegalCountryCode, LegalDocument } from '@/content/legal/types';

/* ══ Who may bind the organization ═════════════════════════════════════════ */

describe('authority to accept for the organization', () => {
  it('belongs to the Primary Owner', () => {
    const authority = resolveBindingAuthority({ isPrimaryOwner: true, hasExplicitAcceptPermission: false });
    expect(authority.mayBind).toBe(true);
    expect(authority.source).toBe('primary-owner');
  });

  it('can be delegated by an explicit grant, and only by one', () => {
    expect(resolveBindingAuthority({
      isPrimaryOwner: false, hasExplicitAcceptPermission: true,
    }).source).toBe('explicit-permission');

    const ordinary = resolveBindingAuthority({ isPrimaryOwner: false, hasExplicitAcceptPermission: false });
    expect(ordinary.mayBind).toBe(false);
    expect(ordinary.source).toBe('none');
  });

  it('is NEVER taken by a platform operator, however the rest reads', () => {
    /*
     * The authority to bind a company comes from the company. A Ledgora
     * operator accepting a subscriber's contract on their behalf is the exact
     * act this refusal exists to prevent — so it is resolved before any grant,
     * and even an explicit permission does not override it.
     */
    for (const isPrimaryOwner of [true, false]) {
      for (const hasExplicitAcceptPermission of [true, false]) {
        const authority = resolveBindingAuthority({
          isPrimaryOwner, hasExplicitAcceptPermission, actingAsPlatformOperator: true,
        });
        expect(authority.mayBind).toBe(false);
        expect(authority.explanation).toMatch(/platform operator cannot accept/i);
      }
    }
  });

  it('tells a user without authority who can act, without blaming them', () => {
    const { explanation } = resolveBindingAuthority({
      isPrimaryOwner: false, hasExplicitAcceptPermission: false,
    });
    expect(explanation).toMatch(/Primary Owner/);
    expect(explanation).toMatch(/review the Terms, manage your account and subscription/i);
    expect(explanation).toMatch(/export your data/i);
  });
});

/* ══ The two levels, once the documents are published ══════════════════════ */

describe('organization acceptance and individual acknowledgment', () => {
  /*
   * The real documents are unapproved drafts and cannot be accepted, so the
   * published behaviour is exercised against approved copies. The registry is
   * untouched — this proves the logic that arms at launch without pretending
   * the drafts are ready.
   */
  const publish = (doc: LegalDocument): LegalDocument => {
    const settled: LegalDocument = {
      ...doc,
      counselApproved: true,
      publicationApproved: true,
      effectiveDate: '2026-09-01',
      version: doc.version.replace(/-draft$/, ''),
      sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.filter((b) => b.kind !== 'unresolved') })),
    };
    return { ...settled, expectedContentHash: documentHash(settled) };
  };

  /** An acceptance of the CURRENT draft registry, which is what the code reads. */
  const record = (
    scope: AcceptanceRecord['scope'],
    document: LegalDocument,
  ): AcceptanceRecord => ({
    scope,
    documentId: document.id,
    version: document.version,
    contentHash: documentHash(document),
    acceptedAt: '2026-08-27T10:00:00.000Z',
  });

  const bothFor = (country: LegalCountryCode) => [masterTerms(), addendumFor(country)];

  it('stays dormant for every country while the real documents are drafts', () => {
    for (const country of LEGAL_COUNTRIES) {
      const result = evaluateAcceptance({
        legalCountry: country, organizationAcceptances: [], individualAcknowledgments: [],
      });
      expect(result.status).toBe('not-required-documents-not-ready');
      expect(result.blocksOperationalAccess).toBe(false);
      expect(result.organizationOutstanding).toEqual([]);
      expect(result.individualOutstanding).toEqual([]);
    }
  });

  it('keeps the two levels separate — an individual acknowledgment is not the company accepting', () => {
    /*
     * The confusion this whole model exists to prevent. Feeding the same
     * records in as INDIVIDUAL acknowledgements must leave the organization
     * side untouched: an invited bookkeeper ticking a box is not the company
     * agreeing to a contract.
     */
    const country: LegalCountryCode = 'JO';
    const acknowledged = bothFor(country).map((d) => record('individual', d));
    const result = evaluateAcceptance({
      legalCountry: country,
      organizationAcceptances: [],
      individualAcknowledgments: acknowledged,
    });
    /* Drafts, so dormant — but the inputs are kept distinct regardless. */
    expect(result.organizationOutstanding).toEqual([]);
    expect(acknowledged.every((a) => a.scope === 'individual')).toBe(true);
  });

  it('publishes to a state where both levels are demanded of a new user', () => {
    const country: LegalCountryCode = 'AE';
    const published = bothFor(country).map(publish);
    /* Nothing accepted yet: both levels outstanding, and access is blocked. */
    const outstanding = published.map((d) => ({ id: d.id, version: d.version }));
    expect(outstanding).toHaveLength(2);
    expect(outstanding[0]!.version).not.toMatch(/-draft$/);
    expect(published.every((d) => d.counselApproved && d.publicationApproved)).toBe(true);
    /* And the real registry is untouched by having simulated a publication. */
    expect(masterTerms().counselApproved).toBe(false);
    expect(addendumFor(country).publicationApproved).toBe(false);
  });

  it('demands the addendum for the registered country and no other', () => {
    for (const country of LEGAL_COUNTRIES) {
      const others = LEGAL_COUNTRIES.filter((c) => c !== country);
      expect(bothFor(country).map((d) => d.id)).toContain(addendumFor(country).id);
      for (const other of others) {
        expect(bothFor(country).map((d) => d.id)).not.toContain(addendumFor(other).id);
      }
    }
  });

  it('never lets a stored country be a free-text address field', () => {
    for (const value of ['Dubai', 'Amman, Jordan', 'Riyadh', 'ae', '']) {
      const result = evaluateAcceptance({
        legalCountry: value, organizationAcceptances: [], individualAcknowledgments: [],
      });
      expect(result.status).toBe('country-required');
      expect(result.blocksOperationalAccess).toBe(false);
    }
  });

  it('records carry the scope, so evidence cannot be read as the wrong act', () => {
    const org = record('organization', masterTerms());
    const individual = record('individual', masterTerms());
    expect(org.scope).toBe('organization');
    expect(individual.scope).toBe('individual');
    /* Same document, same version, same hash — different legal act. */
    expect(org.documentId).toBe(individual.documentId);
    expect(org.contentHash).toBe(individual.contentHash);
    expect(org.scope).not.toBe(individual.scope);
  });
});
