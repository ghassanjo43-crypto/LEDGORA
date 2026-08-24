/**
 * The shape a JoFotara clearance response is assumed to have.
 *
 * ⚠️  ASSUMED, not verified. ISTD's technical specification is not in hand, and
 * every field below comes from the integration brief rather than from the
 * authority's documentation. Treat this file as the thing to correct FIRST when
 * the real specification arrives — the mock, the tests and any parsing code all
 * hang off it, so fixing it here fixes them together.
 *
 * The one field that is certainly ours and not theirs is `mock`. See below.
 */

export type ClearanceStatus = 'CLEARED' | 'NOT_CLEARED' | 'ERROR';

export interface ClearanceError {
  /** Short machine-readable code. Real ISTD codes are not known yet. */
  code: string;
  message: string;
}

export interface ClearanceResponse {
  clearanceStatus: ClearanceStatus;
  uuid: string;
  /** Base64. The mock emits a placeholder; see `mock.ts`. */
  qrCode: string;
  clearanceHash: string;
  errors: ClearanceError[];

  /**
   * Always `true` on anything this mock produced, and absent from a real
   * response.
   *
   * This exists because the expensive failure mode of a clearance mock is not
   * that it behaves wrongly — it is that something downstream believes a
   * document was cleared by a tax authority when it was cleared by a function
   * in this repository. A stored `clearance_status = 'CLEARED'` looks identical
   * either way six months later.
   *
   * So: persist this alongside any stored clearance result, and refuse to treat
   * a record carrying it as evidence of anything. `mock-` prefixed UUIDs are
   * the second line of the same defence.
   */
  mock: true;
}

/** How the mock was asked to behave. */
export type MockMode = 'cleared' | 'rejected' | 'error';

export const MOCK_MODES: readonly MockMode[] = ['cleared', 'rejected', 'error'];

export function isMockMode(value: unknown): value is MockMode {
  return typeof value === 'string' && (MOCK_MODES as readonly string[]).includes(value);
}
