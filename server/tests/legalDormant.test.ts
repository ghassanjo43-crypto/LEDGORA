/**
 * The dormant gate, against the REAL registry.
 *
 * `legalAcceptance.test.ts` mocks `publishedLegalDocuments` so the armed
 * behaviour can be exercised. This file deliberately does NOT: it runs against
 * the real, empty registry, and asserts that while every document is an
 * unapproved draft, no acceptance can be recorded by anyone — including the
 * Primary Owner, and including through the HTTP surface.
 *
 * That matters because the safety property is "nothing can be accepted yet",
 * and a suite that only ever tested the mocked, published state would never
 * check it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestContext,
  login,
  authHeaders,
  seedUser,
  type TestContext,
} from './helpers/testApp.js';
import { createOrganization } from '../src/services/organizationService.js';
import { recordAcceptance, setLegalCountry } from '../src/services/legalService.js';
import {
  PUBLISHED_LEGAL_DOCUMENTS,
  anyDocumentIsPublished,
  publishedBundleFor,
} from '../src/config/publishedLegalDocuments.js';

let ctx: TestContext;

const masterDoc = { documentId: 'master-terms' as const, version: '1.0.0', contentHash: 'a'.repeat(64) };
const uaeDoc = { documentId: 'addendum-ae' as const, version: '1.0.0', contentHash: 'b'.repeat(64) };

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(async () => { await ctx.close(); });

async function ownerWithCountry() {
  const owner = await seedUser(ctx, { email: 'owner@dormant.test', fullName: 'Owner' });
  const org = await createOrganization(ctx.db, owner.id, {
    legalName: 'Dormant Co', country: 'United Arab Emirates',
  });
  await setLegalCountry(ctx.db, {
    organizationId: org.id, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
    mayAdministerLegalCountry: true, authority: 'primary-owner',
  });
  return { owner, organizationId: org.id };
}

describe('while nothing is published', () => {
  it('the registry is empty, and says so', () => {
    expect(PUBLISHED_LEGAL_DOCUMENTS).toEqual([]);
    expect(anyDocumentIsPublished()).toBe(false);
    for (const country of ['AE', 'JO', 'SA'] as const) {
      expect(publishedBundleFor(country)).toBeNull();
    }
  });

  it('refuses an organization acceptance even from the Primary Owner', async () => {
    const { owner, organizationId } = await ownerWithCountry();
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    })).rejects.toThrow(/not published yet/i);
  });

  it('refuses an individual acknowledgment too', async () => {
    const { owner, organizationId } = await ownerWithCountry();
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'individual',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'viewer', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    })).rejects.toThrow(/not published yet/i);
  });

  it('records NOTHING in the table, whatever is attempted', async () => {
    const { owner, organizationId } = await ownerWithCountry();
    for (const scope of ['organization', 'individual'] as const) {
      await recordAcceptance(ctx.db, {
        userId: owner.id, organizationId, scope,
        documents: [masterDoc, uaeDoc],
        bindingAuthorityConfirmed: scope === 'organization',
        actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
      }).catch(() => undefined);
    }
    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('refuses through the HTTP surface as well', async () => {
    await ownerWithCountry();
    const cookies = await login(ctx, 'owner@dormant.test');
    const response = await ctx.app.inject({
      method: 'POST', url: '/api/organizations/current/legal/acceptance',
      headers: authHeaders(cookies),
      payload: { scope: 'organization', documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/not published yet/i);
  });

  it('still lets the country be selected — that is not an acceptance', async () => {
    /*
     * Choosing the registered legal country is a precondition of being ABLE to
     * accept, not an acceptance. It must stay available while the documents are
     * drafts, or an organization could not be ready for publication day.
     */
    const { organizationId } = await ownerWithCountry();
    const org = await ctx.db.selectFrom('organizations').select(['legal_country'])
      .where('id', '=', organizationId).executeTakeFirstOrThrow();
    expect(org.legal_country).toBe('AE');
  });
});
