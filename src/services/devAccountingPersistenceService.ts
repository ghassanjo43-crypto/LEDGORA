/**
 * DEVELOPMENT accounting-persistence adapter.
 *
 * Business records are held by the accounting stores, which persist through
 * `lib/workspaceStorage`. This service is the explicit seam a backend replaces:
 * it refuses to write whenever the active persistence policy is memory-only, so
 * a Free Demo can never be pushed to a permanent store.
 *
 * ── BACKEND SEAM ──────────────────────────────────────────────────────────────
 *   saveRecord()    → POST /api/orgs/{organizationId}/records
 *   loadWorkspace() → GET  /api/orgs/{organizationId}/workspace
 */
import type { AccountingPersistenceService } from './types';
import { readSessionState } from '@/store/sessionSnapshot';

export class PersistenceNotPermittedError extends Error {
  constructor() {
    super('This workspace is temporary — records are kept in memory for this session only.');
    this.name = 'PersistenceNotPermittedError';
  }
}

export const devAccountingPersistenceService: AccountingPersistenceService = {
  async saveRecord(record) {
    const session = readSessionState();
    if (!session.canPersistData) {
      // Free demo / unsubscribed: the record stays in the in-memory workspace.
      void record;
      throw new PersistenceNotPermittedError();
    }
    // BACKEND SEAM: POST the record to the accounting API. Until then the
    // accounting stores' own persistence (workspaceStorage) is the durable path.
    void record;
  },

  async loadWorkspace(organizationId) {
    const session = readSessionState();
    if (!session.canPersistData) return null;
    // BACKEND SEAM: GET the organization workspace from the accounting API.
    void organizationId;
    return null;
  },
};
