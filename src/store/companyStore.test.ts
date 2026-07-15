import { describe, it, expect, beforeEach } from 'vitest';
import { useCompanyStore } from './companyStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';

describe('company store (multi-company books isolation)', () => {
  beforeEach(() => {
    // Reset to a single freshly-initialised company from the seed working data.
    useStore.getState().resetToDefault();
    useJournalStore.getState().resetToDefault();
    useCompanyStore.setState({ companies: [], activeCompanyId: '' });
    useCompanyStore.getState().ensureInitialized();
  });

  it('initialises one company from the current books', () => {
    const s = useCompanyStore.getState();
    expect(s.companies).toHaveLength(1);
    expect(s.activeCompanyId).toBe(s.companies[0]!.id);
    expect(useJournalStore.getState().entries.length).toBeGreaterThan(0);
  });

  it('adds a new company with a fresh chart and empty journal, and switches to it', () => {
    const seedCount = useJournalStore.getState().entries.length;
    const res = useCompanyStore.getState().addCompany({ companyName: 'Beta Co', baseCurrency: 'EUR' }, true);
    expect(res.ok).toBe(true);
    // Working journal is now the new (empty) company's ledger.
    expect(useJournalStore.getState().entries).toHaveLength(0);
    expect(useStore.getState().settings.companyName).toBe('Beta Co');
    expect(useStore.getState().accounts.length).toBeGreaterThan(0); // seeded chart
    expect(useJournalStore.getState().entries.length).not.toBe(seedCount);
  });

  it('keeps each company’s books isolated when switching back and forth', () => {
    const first = useCompanyStore.getState().activeCompanyId;
    const originalEntries = useJournalStore.getState().entries.length;

    const beta = useCompanyStore.getState().addCompany({ companyName: 'Beta Co' }, true).id!;
    expect(useJournalStore.getState().entries).toHaveLength(0);

    // Back to the first company: its journal returns intact.
    useCompanyStore.getState().switchCompany(first);
    expect(useJournalStore.getState().entries).toHaveLength(originalEntries);

    // And Beta is still empty.
    useCompanyStore.getState().switchCompany(beta);
    expect(useJournalStore.getState().entries).toHaveLength(0);
  });

  it('cannot delete the active company or the last remaining company', () => {
    const active = useCompanyStore.getState().activeCompanyId;
    expect(useCompanyStore.getState().deleteCompany(active).ok).toBe(false);

    const beta = useCompanyStore.getState().addCompany({ companyName: 'Beta Co' }, true).id!;
    // active is now beta; delete the first one (allowed)
    const del = useCompanyStore.getState().deleteCompany(active);
    expect(del.ok).toBe(true);
    expect(useCompanyStore.getState().companies).toHaveLength(1);
    // now only beta remains and is active → cannot delete
    expect(useCompanyStore.getState().deleteCompany(beta).ok).toBe(false);
  });
});
