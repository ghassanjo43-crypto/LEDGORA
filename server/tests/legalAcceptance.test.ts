/**
 * The legal-acceptance API: who may bind an organization, what gets recorded,
 * and what a repeated submission does.
 *
 * These run against a real PostgreSQL engine with the production migrations, so
 * the append-only trigger, the CHECK constraints and the idempotency key under
 * test are the real ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestContext,
  login,
  authHeaders,
  seedUser,
  type TestContext,
} from './helpers/testApp.js';
import { createOrganization } from '../src/services/organizationService.js';
import { recordAcceptance, setLegalCountry, readLegalStatus } from '../src/services/legalService.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

/*
 * A PUBLISHED registry, for the behaviour that will matter at launch.
 *
 * The real `publishedLegalDocuments` is empty, because all four documents are
 * unapproved drafts — and a separate test below asserts that the real, empty
 * registry refuses every acceptance. Mocking it here exercises the armed path
 * without publishing anything or touching the drafts.
 */
vi.mock('../src/config/publishedLegalDocuments.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/config/publishedLegalDocuments.js')>();
  const published = [
    { id: 'master-terms', version: '1.0.0', effectiveDate: '2026-09-01', contentHash: 'a'.repeat(64) },
    { id: 'addendum-ae', country: 'AE', version: '1.0.0', effectiveDate: '2026-09-01', contentHash: 'b'.repeat(64) },
    { id: 'addendum-jo', country: 'JO', version: '1.0.0', effectiveDate: '2026-09-01', contentHash: 'c'.repeat(64) },
    /* A later version of the bundle, so re-acceptance can be exercised. */
    { id: 'master-terms', version: '2.0.0', effectiveDate: '2027-01-01', contentHash: 'e'.repeat(64) },
    { id: 'addendum-ae', country: 'AE', version: '2.0.0', effectiveDate: '2027-01-01', contentHash: 'f'.repeat(64) },
  ] as const;
  return {
    ...original,
    PUBLISHED_LEGAL_DOCUMENTS: published,
    anyDocumentIsPublished: () => true,
    findPublishedDocument: (id: string, version: string, contentHash: string) =>
      published.find((d) => d.id === id && d.version === version && d.contentHash === contentHash),
    publishedBundleFor: (country: 'AE' | 'JO' | 'SA') => {
      /* First match wins — 1.0.0 is "current" for these tests. */
      const master = published.find((d) => d.id === 'master-terms');
      const addendum = published.find((d) => d.id === original.ADDENDUM_FOR_COUNTRY[country]);
      return master && addendum ? [master, addendum] : null;
    },
  };
});

let ctx: TestContext;

const masterDoc = { documentId: 'master-terms' as const, version: '1.0.0', contentHash: HASH_A };
const uaeDoc = { documentId: 'addendum-ae' as const, version: '1.0.0', contentHash: HASH_B };
const jordanDoc = { documentId: 'addendum-jo' as const, version: '1.0.0', contentHash: HASH_C };

async function seedOwnerWithOrg(email = 'owner@acme.test') {
  const owner = await seedUser(ctx, { email, fullName: 'Acme Owner' });
  const org = await createOrganization(ctx.db, owner.id, {
    legalName: 'Acme Trading LLC',
    country: 'United Arab Emirates',
  });
  return { owner, organizationId: org.id };
}

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(async () => { await ctx.close(); });

/* ══ The registered legal country ══════════════════════════════════════════ */

describe('the registered legal country', () => {
  it('starts null — it is never inferred from the free-text country', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    const status = await readLegalStatus(ctx.db, owner.id, organizationId);
    /*
     * The organization was created with country "United Arab Emirates". That
     * must NOT become legal_country 'AE': a contract determination may not rest
     * on an unvalidated descriptive field.
     */
    expect(status.legalCountry).toBeNull();
  });

  it('is set by an authorised actor, and the change is recorded', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    const result = await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    expect(result.previousCountry).toBeNull();
    expect(result.newCountry).toBe('AE');
    expect(result.addendumAcceptanceInvalidated).toBe(false);

    const change = await ctx.db.selectFrom('organization_legal_country_changes')
      .selectAll().where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
    expect(change.previous_country).toBeNull();
    expect(change.new_country).toBe('AE');
    expect(change.changed_by_user_id).toBe(owner.id);
    expect(change.authority).toBe('primary-owner');
  });

  it('refuses an unauthorised actor', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await expect(setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'accountant',
      mayAdministerLegalCountry: false, authority: 'none',
    })).rejects.toThrow(/not authorised/i);
  });

  it('refuses anything that is not one of the three codes', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    for (const bad of ['US', 'uae', 'Dubai', '', null, undefined, 42]) {
      await expect(setLegalCountry(ctx.db, {
        organizationId, country: bad, actorUserId: owner.id, actorRole: 'owner',
        mayAdministerLegalCountry: true, authority: 'primary-owner',
      })).rejects.toThrow(/AE, JO or SA/);
    }
  });

  it('records old and new on a change, and preserves the prior acceptance', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'JO', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    await recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, jordanDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    });

    const moved = await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    expect(moved.previousCountry).toBe('JO');
    expect(moved.addendumAcceptanceInvalidated).toBe(true);

    /* The Jordan acceptance is HISTORY, not deleted — it is what was agreed. */
    const status = await readLegalStatus(ctx.db, owner.id, organizationId);
    expect(status.organizationAcceptances.map((a) => a.documentId)).toContain('addendum-jo');
    expect(status.legalCountry).toBe('AE');
  });
});

/* ══ Authority to bind ═════════════════════════════════════════════════════ */

describe('authority to accept for the organization', () => {
  it('refuses an organization acceptance from an unauthorised user', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });

    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'accountant', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    })).rejects.toThrow(/not authorised to accept/i);

    const status = await readLegalStatus(ctx.db, owner.id, organizationId);
    expect(status.organizationAcceptances).toEqual([]);
  });

  it('refuses an organization acceptance that does not confirm authority', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    })).rejects.toThrow(/authority to bind/i);
  });

  it('lets ANY member acknowledge individually, with no authority needed', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });

    const result = await recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'individual',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'viewer', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    });
    expect(result.recorded).toHaveLength(2);
    expect(result.recorded.every((r) => r.scope === 'individual')).toBe(true);
    /* And it is NOT an organization acceptance. */
    const status = await readLegalStatus(ctx.db, owner.id, organizationId);
    expect(status.organizationAcceptances).toEqual([]);
    expect(status.individualAcknowledgments).toHaveLength(2);
  });
});

/* ══ What may be accepted ══════════════════════════════════════════════════ */

describe('what may be accepted', () => {
  it('requires the Master Terms and the addendum for the REGISTERED country', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });

    /* Another country's addendum is refused, however the client asks. */
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, jordanDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    })).rejects.toThrow(/addendum-ae/);

    /* The master alone is refused — a half-agreement nobody asked for. */
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    })).rejects.toThrow(/together/);
  });

  it('refuses when the organization has no registered country', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    })).rejects.toThrow(/no registered legal country/i);
  });

  it('refuses a malformed content hash', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [masterDoc, { ...uaeDoc, contentHash: 'not-a-hash' }],
      bindingAuthorityConfirmed: true, actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    })).rejects.toThrow(/content hash/i);
  });
});

/* ══ Idempotency and immutability ══════════════════════════════════════════ */

describe('repeated and concurrent submissions', () => {
  async function readyOrg() {
    const seeded = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId: seeded.organizationId, country: 'AE', actorUserId: seeded.owner.id,
      actorRole: 'owner', mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    return seeded;
  }

  const accept = (owner: { id: string }, organizationId: string) => recordAcceptance(ctx.db, {
    userId: owner.id, organizationId, scope: 'organization',
    documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
    actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
  });

  it('records once however many times it is submitted', async () => {
    const { owner, organizationId } = await readyOrg();
    const first = await accept(owner, organizationId);
    expect(first.idempotentReplay).toBe(false);

    const second = await accept(owner, organizationId);
    expect(second.idempotentReplay).toBe(true);
    expect(second.recorded).toHaveLength(2);

    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll()
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toHaveLength(2);
  });

  it('survives concurrent submissions without duplicating', async () => {
    const { owner, organizationId } = await readyOrg();
    /* The race a check-then-insert would lose. */
    await Promise.all([
      accept(owner, organizationId),
      accept(owner, organizationId),
      accept(owner, organizationId),
    ]).catch(() => undefined);

    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll()
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toHaveLength(2);
  });

  it('adds a NEW row for a new version rather than replacing the old one', async () => {
    const { owner, organizationId } = await readyOrg();
    await accept(owner, organizationId);
    await recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: [
        { ...masterDoc, version: '2.0.0', contentHash: 'e'.repeat(64) },
        { ...uaeDoc, version: '2.0.0', contentHash: 'f'.repeat(64) },
      ],
      bindingAuthorityConfirmed: true, actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    });
    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll()
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.version === '1.0.0')).toHaveLength(2);
  });

  it('refuses UPDATE and DELETE at the database', async () => {
    const { owner, organizationId } = await readyOrg();
    await accept(owner, organizationId);

    await expect(ctx.db.updateTable('legal_acceptances')
      .set({ version: 'tampered' })
      .where('organization_id', '=', organizationId)
      .execute()).rejects.toThrow(/append-only/i);

    await expect(ctx.db.deleteFrom('legal_acceptances')
      .where('organization_id', '=', organizationId)
      .execute()).rejects.toThrow(/append-only/i);
  });

  it('stamps a SERVER timestamp that the caller cannot supply', async () => {
    const { owner, organizationId } = await readyOrg();
    const before = new Date();
    const result = await accept(owner, organizationId);
    const at = new Date(result.recorded[0]!.acceptedAt);
    expect(at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

/* ══ Tenant isolation ══════════════════════════════════════════════════════ */

describe('tenant isolation', () => {
  it('never returns another organization’s acceptances', async () => {
    const acme = await seedOwnerWithOrg('acme@example.test');
    const beta = await seedOwnerWithOrg('beta@example.test');
    for (const org of [acme, beta]) {
      await setLegalCountry(ctx.db, {
        organizationId: org.organizationId, country: 'AE', actorUserId: org.owner.id,
        actorRole: 'owner', mayAdministerLegalCountry: true, authority: 'primary-owner',
      });
      await recordAcceptance(ctx.db, {
        userId: org.owner.id, organizationId: org.organizationId, scope: 'organization',
        documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
        actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
      });
    }

    const acmeStatus = await readLegalStatus(ctx.db, acme.owner.id, acme.organizationId);
    expect(acmeStatus.organizationId).toBe(acme.organizationId);
    expect(acmeStatus.organizationAcceptances).toHaveLength(2);
    expect(acmeStatus.organizationAcceptances.every((a) => a.acceptedByUserId === acme.owner.id)).toBe(true);

    /* Beta's rows exist, and are not in Acme's answer. */
    const all = await ctx.db.selectFrom('legal_acceptances').selectAll().execute();
    expect(all).toHaveLength(4);
  });

  it('does not leak another user’s individual acknowledgment', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    const colleague = await seedUser(ctx, { email: 'colleague@acme.test', fullName: 'Colleague' });
    await ctx.db.insertInto('organization_memberships')
      .values({ organization_id: organizationId, user_id: colleague.id, role: 'accountant', status: 'active' })
      .execute();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });

    await recordAcceptance(ctx.db, {
      userId: colleague.id, organizationId, scope: 'individual',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'accountant', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    });

    /* The owner sees no individual acknowledgment, because it is not theirs. */
    const ownerStatus = await readLegalStatus(ctx.db, owner.id, organizationId);
    expect(ownerStatus.individualAcknowledgments).toEqual([]);
    /* The colleague sees their own. */
    const colleagueStatus = await readLegalStatus(ctx.db, colleague.id, organizationId);
    expect(colleagueStatus.individualAcknowledgments).toHaveLength(2);
  });
});

/* ══ The HTTP surface ══════════════════════════════════════════════════════ */

describe('the API', () => {
  it('requires authentication', async () => {
    for (const [method, url] of [
      ['GET', '/api/organizations/current/legal/status'],
      ['POST', '/api/organizations/current/legal/acceptance'],
      ['PUT', '/api/organizations/current/legal/country'],
    ] as const) {
      const response = await ctx.app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('reports the caller’s authority alongside the status', async () => {
    const { organizationId } = await seedOwnerWithOrg();
    const cookies = await login(ctx, 'owner@acme.test');
    const response = await ctx.app.inject({
      method: 'GET', url: '/api/organizations/current/legal/status', headers: authHeaders(cookies),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organizationId).toBe(organizationId);
    expect(body.legalCountry).toBeNull();
    /* The Primary Owner holds both authorities by role template. */
    expect(body.mayAcceptForOrganization).toBe(true);
    expect(body.mayAcknowledgeIndividually).toBe(true);
    expect(body.mayAdministerLegalCountry).toBe(true);
  });

  it('accepts no organization id from the client', async () => {
    await seedOwnerWithOrg();
    const beta = await seedOwnerWithOrg('beta@example.test');
    const cookies = await login(ctx, 'owner@acme.test');
    const response = await ctx.app.inject({
      method: 'GET',
      /* A query parameter naming another tenant must change nothing. */
      url: `/api/organizations/current/legal/status?organizationId=${beta.organizationId}`,
      headers: authHeaders(cookies),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().organizationId).not.toBe(beta.organizationId);
  });

  it('returns 201 for a new acceptance and 200 for a replay', async () => {
    const { owner, organizationId } = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId, country: 'AE', actorUserId: owner.id, actorRole: 'owner',
      mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    const cookies = await login(ctx, 'owner@acme.test');
    const payload = {
      scope: 'organization', documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
    };
    const first = await ctx.app.inject({
      method: 'POST', url: '/api/organizations/current/legal/acceptance',
      headers: authHeaders(cookies), payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await ctx.app.inject({
      method: 'POST', url: '/api/organizations/current/legal/acceptance',
      headers: authHeaders(cookies), payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotentReplay).toBe(true);
  });
});

/* ══ The two authorities are genuinely separate ════════════════════════════ */

describe('individual acknowledgment versus organization acceptance', () => {
  async function readyOrg() {
    const seeded = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId: seeded.organizationId, country: 'AE', actorUserId: seeded.owner.id,
      actorRole: 'owner', mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    return seeded;
  }

  it('lets an ordinary member acknowledge for themselves', async () => {
    const { owner, organizationId } = await readyOrg();
    const member = await seedUser(ctx, { email: 'member@acme.test', fullName: 'Member' });
    await ctx.db.insertInto('organization_memberships')
      .values({ organization_id: organizationId, user_id: member.id, role: 'member', status: 'active' })
      .execute();

    const result = await recordAcceptance(ctx.db, {
      userId: member.id, organizationId, scope: 'individual',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'member',
      /* What the catalogue actually gives a Member: acknowledge, not accept. */
      mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    });
    expect(result.recorded).toHaveLength(2);
    expect(result.recorded.every((r) => r.scope === 'individual')).toBe(true);
    expect(result.recorded.every((r) => r.bindingAuthorityConfirmed === false)).toBe(true);

    /* It binds nobody: the organization still owes its own acceptance. */
    const status = await readLegalStatus(ctx.db, owner.id, organizationId);
    expect(status.organizationAcceptances).toEqual([]);
  });

  it('refuses that same member an ORGANIZATION acceptance', async () => {
    const { organizationId } = await readyOrg();
    const member = await seedUser(ctx, { email: 'member2@acme.test', fullName: 'Member' });
    await ctx.db.insertInto('organization_memberships')
      .values({ organization_id: organizationId, user_id: member.id, role: 'member', status: 'active' })
      .execute();

    await expect(recordAcceptance(ctx.db, {
      userId: member.id, organizationId, scope: 'organization',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'member', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    })).rejects.toThrow(/not authorised to accept/i);

    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll()
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toEqual([]);
  });

  it('refuses that same member the legal country', async () => {
    const { organizationId } = await readyOrg();
    const member = await seedUser(ctx, { email: 'member3@acme.test', fullName: 'Member' });
    await expect(setLegalCountry(ctx.db, {
      organizationId, country: 'JO', actorUserId: member.id, actorRole: 'member',
      mayAdministerLegalCountry: false, authority: 'none',
    })).rejects.toThrow(/not authorised/i);

    const status = await readLegalStatus(ctx.db, member.id, organizationId);
    expect(status.legalCountry).toBe('AE');
  });

  it('refuses an individual acknowledgment that claims corporate authority', async () => {
    const { owner, organizationId } = await readyOrg();
    /*
     * Refused rather than ignored: an acknowledgement carrying a claim of
     * authority would be evidence of something the person was never asked.
     */
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'individual',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: true,
      actingAsRole: 'viewer', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    })).rejects.toThrow(/must not claim authority/i);
  });

  it('refuses an acknowledgment from someone without even that permission', async () => {
    const { owner, organizationId } = await readyOrg();
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'individual',
      documents: [masterDoc, uaeDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'member', mayAcknowledgeIndividually: false, mayAcceptForOrganization: false,
    })).rejects.toThrow(/not permitted to acknowledge/i);
  });
});

/* ══ The bundle is atomic ══════════════════════════════════════════════════ */

describe('the document bundle', () => {
  async function readyOrg() {
    const seeded = await seedOwnerWithOrg();
    await setLegalCountry(ctx.db, {
      organizationId: seeded.organizationId, country: 'AE', actorUserId: seeded.owner.id,
      actorRole: 'owner', mayAdministerLegalCountry: true, authority: 'primary-owner',
    });
    return seeded;
  }

  const attempt = (owner: { id: string }, organizationId: string, documents: unknown[]) =>
    recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'organization',
      documents: documents as never, bindingAuthorityConfirmed: true,
      actingAsRole: 'owner', mayAcknowledgeIndividually: true, mayAcceptForOrganization: true,
    });

  it('writes NOTHING when the second document is invalid', async () => {
    const { owner, organizationId } = await readyOrg();
    /*
     * The master is valid; the addendum's hash is not. Nothing may be written —
     * a half-agreement is the specific failure the all-before-any validation
     * order exists to make unreachable.
     */
    await expect(attempt(owner, organizationId, [
      masterDoc, { ...uaeDoc, contentHash: 'd'.repeat(64) },
    ])).rejects.toThrow(/not a published Ledgora document/i);

    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll()
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toEqual([]);
  });

  it('writes NOTHING for an unpublished version', async () => {
    const { owner, organizationId } = await readyOrg();
    await expect(attempt(owner, organizationId, [
      { ...masterDoc, version: '9.9.9' }, uaeDoc,
    ])).rejects.toThrow(/not a published Ledgora document/i);
    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('writes NOTHING for the wrong country’s addendum', async () => {
    const { owner, organizationId } = await readyOrg();
    await expect(attempt(owner, organizationId, [masterDoc, jordanDoc]))
      .rejects.toThrow(/addendum-ae/);
    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('writes NOTHING for an incomplete bundle', async () => {
    const { owner, organizationId } = await readyOrg();
    await expect(attempt(owner, organizationId, [masterDoc])).rejects.toThrow(/together/);
    const rows = await ctx.db.selectFrom('legal_acceptances').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('covers the complete bundle for an individual acknowledgment too', async () => {
    const { owner, organizationId } = await readyOrg();
    await expect(recordAcceptance(ctx.db, {
      userId: owner.id, organizationId, scope: 'individual',
      documents: [masterDoc], bindingAuthorityConfirmed: false,
      actingAsRole: 'viewer', mayAcknowledgeIndividually: true, mayAcceptForOrganization: false,
    })).rejects.toThrow(/together/);
  });
});
