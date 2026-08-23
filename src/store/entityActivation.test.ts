// @vitest-environment happy-dom
/**
 * Entities and the package's entity slots.
 *
 * A subscriber may keep as many sets of books as they like; the package caps
 * how many are ACTIVE at once. Deactivating frees a slot and keeps every
 * record, so a one-entity package can hold several businesses or several years
 * and work in one at a time.
 *
 * These pin the slot arithmetic, because it is the commercial rule: get it
 * wrong one way and a subscriber is blocked from books they paid for, wrong the
 * other and the entity limit sells nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useCompanyStore, activeEntityCount, isActiveEntity, entityStatus } from '@/store/companyStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useStore } from '@/store/useStore';

const allowEntities = (entityLimit: number): void => {
  useEntitlementStore.setState((s) => ({
    subscription: { ...s.subscription, entityLimit },
  }));
};

/** Companies as the registry holds them, without touching the working stores. */
const seedCompanies = (...names: string[]): string[] => {
  const companies = names.map((name, index) => ({
    id: `co-${index + 1}`,
    settings: { ...useStore.getState().settings, companyName: name },
    accounts: [], entities: [], entries: [],
    isActive: true,
  }));
  useCompanyStore.setState({ companies, activeCompanyId: companies[0]!.id });
  return companies.map((c) => c.id);
};

beforeEach(() => {
  localStorage.clear();
  allowEntities(3);
});

describe('counting slots', () => {
  it('treats a record written before activation existed as active', () => {
    // Reading an absent flag as `false` would deactivate every existing
    // subscriber's books the moment this shipped.
    expect(isActiveEntity({ isActive: undefined })).toBe(true);
    expect(isActiveEntity({ isActive: true })).toBe(true);
    expect(isActiveEntity({ isActive: false })).toBe(false);
  });

  it('counts only active entities against the allowance', () => {
    const [, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.getState().deactivateCompany(second!);
    expect(activeEntityCount(useCompanyStore.getState().companies)).toBe(1);
  });
});

describe('deactivating', () => {
  it('keeps the books and frees a slot', () => {
    allowEntities(2);
    const [first, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.setState((s) => ({
      companies: s.companies.map((c) => (c.id === second ? { ...c, entries: [{ id: 'e1' } as never] } : c)),
    }));

    expect(useCompanyStore.getState().deactivateCompany(second!).ok).toBe(true);

    const beta = useCompanyStore.getState().companies.find((c) => c.id === second)!;
    expect(beta.entries).toHaveLength(1); // records untouched
    expect(isActiveEntity(beta)).toBe(false);
    // The freed slot is immediately usable.
    expect(useCompanyStore.getState().addCompany({ companyName: 'Gamma' }, false).ok).toBe(true);
    void first;
  });

  it('refuses to deactivate the entity currently open', () => {
    const [first] = seedCompanies('Alpha', 'Beta');
    const result = useCompanyStore.getState().deactivateCompany(first!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/switch to another company/i);
    expect(isActiveEntity(useCompanyStore.getState().companies[0]!)).toBe(true);
  });
});

describe('activating', () => {
  it('refuses when every slot is taken, and names the way out', () => {
    allowEntities(1);
    const [, second] = seedCompanies('Alpha', 'Beta');
    // Beta is deactivated; Alpha holds the single slot.
    useCompanyStore.setState((s) => ({
      companies: s.companies.map((c) => (c.id === second ? { ...c, isActive: false } : c)),
    }));

    const result = useCompanyStore.getState().activateCompany(second!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allows 1 active entity/i);
    expect(result.error).toMatch(/deactivate another entity or upgrade/i);
  });

  it('succeeds once a slot has been freed', () => {
    allowEntities(1);
    const [first, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.setState((s) => ({
      companies: s.companies.map((c) => (c.id === second ? { ...c, isActive: false } : c)),
      activeCompanyId: second!, // so Alpha is not the open one
    }));

    expect(useCompanyStore.getState().deactivateCompany(first!).ok).toBe(true);
    expect(useCompanyStore.getState().activateCompany(second!).ok).toBe(true);
  });
});

describe('the allowance bounds every way in', () => {
  it('refuses a new entity when no slot is free', () => {
    allowEntities(1);
    seedCompanies('Alpha');
    const result = useCompanyStore.getState().addCompany({ companyName: 'Beta' }, false);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/deactivate an entity or upgrade/i);
    expect(useCompanyStore.getState().companies).toHaveLength(1);
  });

  it('refuses to open a deactivated entity', () => {
    const [, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.getState().deactivateCompany(second!);
    const result = useCompanyStore.getState().switchCompany(second!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/deactivated/i);
    // And the books on screen did not change.
    expect(useCompanyStore.getState().activeCompanyId).not.toBe(second);
  });
});

/**
 * Archiving, and the gate it puts in front of deletion.
 *
 * A subscriber's books live in this browser and nowhere else — there is no
 * server copy to restore from. So destruction is staged: archive (reversible,
 * keeps everything), then delete. The platform console already treats an
 * operator's organizations this way; a subscriber's own books get the same care.
 */
describe('archiving', () => {
  it('keeps the records, frees the slot, and can be undone', () => {
    allowEntities(1);
    const [, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.setState((s) => ({
      companies: s.companies.map((c) => (c.id === second ? { ...c, entries: [{ id: 'e1' } as never] } : c)),
    }));

    expect(useCompanyStore.getState().archiveCompany(second!).ok).toBe(true);
    const archived = useCompanyStore.getState().companies.find((c) => c.id === second)!;
    expect(archived.entries).toHaveLength(1);
    expect(entityStatus(archived)).toBe('archived');
    expect(activeEntityCount(useCompanyStore.getState().companies)).toBe(1); // Beta's slot released

    expect(useCompanyStore.getState().restoreCompany(second!).ok).toBe(true);
    // Restored DEACTIVATED — taking a slot is a separate, deliberate step.
    expect(entityStatus(useCompanyStore.getState().companies.find((c) => c.id === second)!)).toBe('inactive');
  });

  it('refuses to archive the entity currently open', () => {
    const [first] = seedCompanies('Alpha', 'Beta');
    const result = useCompanyStore.getState().archiveCompany(first!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/switch to another company/i);
  });

  it('cannot be opened or activated while archived', () => {
    const [, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.getState().archiveCompany(second!);

    expect(useCompanyStore.getState().switchCompany(second!).error).toMatch(/archived/i);
    expect(useCompanyStore.getState().activateCompany(second!).error).toMatch(/restore it/i);
  });
});

describe('deleting', () => {
  it('is refused until the entity has been archived', () => {
    const [, second] = seedCompanies('Alpha', 'Beta');

    const tooSoon = useCompanyStore.getState().deleteCompany(second!);
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.error).toMatch(/archive this company before deleting/i);
    expect(useCompanyStore.getState().companies).toHaveLength(2); // still there

    // Deactivating is NOT archiving — the gate is specifically archived.
    useCompanyStore.getState().deactivateCompany(second!);
    expect(useCompanyStore.getState().deleteCompany(second!).ok).toBe(false);

    useCompanyStore.getState().archiveCompany(second!);
    expect(useCompanyStore.getState().deleteCompany(second!).ok).toBe(true);
    expect(useCompanyStore.getState().companies).toHaveLength(1);
  });

  it('still refuses the entity currently open', () => {
    const [first] = seedCompanies('Alpha', 'Beta');
    expect(useCompanyStore.getState().deleteCompany(first!).error).toMatch(/switch to another company/i);
  });

  it('still refuses the last entity standing, even archived', () => {
    const [, second] = seedCompanies('Alpha', 'Beta');
    useCompanyStore.getState().archiveCompany(second!);

    // Leave exactly one company, archived, and not the open one — so the only
    // rule that can refuse the delete is the last-one-standing rule.
    useCompanyStore.setState({
      companies: useCompanyStore.getState().companies.filter((c) => c.id === second),
      activeCompanyId: 'no-such-company',
    });

    const result = useCompanyStore.getState().deleteCompany(second!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/keep at least one company/i);
  });
});
