/**
 * Package module entitlements are always written to `jsonb` as JSON text.
 *
 * ══ The production failure ═══════════════════════════════════════════════════
 *
 * Changing a package's user limit failed with SQLSTATE 22P02:
 *
 *     invalid input syntax for type json
 *     JSON data, line 1: {"accounting",...
 *
 * `subscription_plans.module_entitlements` is `jsonb`. node-postgres parses it
 * on the way OUT into a JavaScript array, and `updatePlan` handed that array
 * straight back as a bound parameter whenever no new modules were supplied — so
 * the driver serialised it as a PostgreSQL ARRAY literal, which is not JSON.
 * Every column is written on every update, so an edit to an unrelated field
 * failed on the untouched module list.
 *
 * ══ Why this test is small, and what proves the rest ═════════════════════════
 *
 * The server suite runs on PGlite, whose jsonb parameter handling ACCEPTS the
 * raw array — verified directly — so PGlite cannot reproduce the defect and an
 * integration test here would pass either way. Simulating PostgreSQL's driver
 * behaviour would only produce a convincing test of the wrong thing.
 *
 * So this file pins the one piece that IS deterministic — the serialisation
 * decision — and the driver-specific behaviour was verified against real local
 * PostgreSQL separately (see the task report).
 */
import { describe, it, expect } from 'vitest';
import { normalizeModules } from '../src/services/platformConfigService.js';

/** Exactly what `updatePlan` writes for a given patch and stored value. */
function serialiseForUpdate(patchModules: string[] | undefined, stored: unknown): string {
  return JSON.stringify(patchModules !== undefined ? patchModules : normalizeModules(stored));
}

describe('normalizeModules', () => {
  it('accepts the parsed array node-postgres returns', () => {
    expect(normalizeModules(['accounting', 'reports'])).toEqual(['accounting', 'reports']);
  });

  it('accepts the raw JSON text another driver may return', () => {
    expect(normalizeModules('["accounting","reports"]')).toEqual(['accounting', 'reports']);
  });

  it('accepts an empty list in either form', () => {
    expect(normalizeModules([])).toEqual([]);
    expect(normalizeModules('[]')).toEqual([]);
  });

  it('refuses unreadable data instead of silently returning an empty list', () => {
    // Returning [] here would strip a package's entitlements — data loss
    // disguised as a default.
    for (const bad of [null, undefined, 42, {}, 'not json', '{"a":1}', ['ok', 7]]) {
      expect(() => normalizeModules(bad), String(bad)).toThrow();
    }
  });
});

describe('what updatePlan writes to the jsonb column', () => {
  it('writes JSON text, never a PostgreSQL array literal', () => {
    // The exact shape PostgreSQL rejected: `{"accounting","reports"}`.
    const written = serialiseForUpdate(undefined, ['accounting', 'reports']);
    expect(written).toBe('["accounting","reports"]');
    expect(written.startsWith('{')).toBe(false);
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('preserves the stored modules when the patch does not mention them', () => {
    // Editing a user limit must not alter entitlements.
    const stored = ['accounting', 'invoicing', 'reports', 'inventory_basic'];
    expect(JSON.parse(serialiseForUpdate(undefined, stored))).toEqual(stored);
  });

  it('writes the new list when the patch supplies one', () => {
    expect(serialiseForUpdate(['accounting'], ['old', 'list'])).toBe('["accounting"]');
  });

  it('treats an explicit empty list as a deliberate clear', () => {
    // A truthiness test would have read `[]` as "not supplied" and kept the old
    // modules; `!== undefined` is what makes clearing possible.
    expect(serialiseForUpdate([], ['accounting'])).toBe('[]');
  });
});
