/**
 * The JoFotara clearance mock.
 *
 * The most valuable test here is the one that feeds it the output of our own
 * UBL builder: the mock and the builder were written against the same assumed
 * contract, and if they ever disagree about what a submittable document looks
 * like, that is a bug in one of them rather than in a hand-written fixture.
 *
 * Everything else pins the properties that stop a fabricated verdict being
 * mistaken for a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { joFotaraMockRoutes, checkStructure, extractXml, resolveMode } from '../src/services/joFotara/index.js';
import { buildInvoiceXml } from '../src/services/invoicing/ubl/invoiceXml.js';
import { PLACEHOLDER_PROFILE } from '../src/services/invoicing/ubl/ublProfile.js';
import { loadConfig } from '../src/config/env.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(joFotaraMockRoutes);
  await app.ready();
});
afterEach(async () => app.close());

/** A document produced by our own builder — the thing we will actually submit. */
const realDocument = (): string =>
  buildInvoiceXml(
    {
      invoiceNumber: 'INV-2026-0001',
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      currencyCode: 'JOD',
      supplier: { name: 'Ledgora Test LLC', taxNumber: '123456789', city: 'Amman', countryCode: 'JO' },
      customer: { name: 'Acme Trading', taxNumber: '987654321', city: 'Irbid', countryCode: 'JO' },
      lines: [{
        id: '1', quantity: '2', unitCode: 'PCE',
        lineExtensionAmount: '200.000', unitPrice: '100.000',
        taxAmount: '32.000', taxPercent: '16.00', itemName: 'Consulting',
      }],
      lineExtensionAmount: '200.000',
      taxExclusiveAmount: '200.000',
      taxInclusiveAmount: '232.000',
      payableAmount: '232.000',
      taxAmount: '32.000',
    },
    PLACEHOLDER_PROFILE,
  );

const submit = (payload: unknown, options: { url?: string; headers?: Record<string, string> } = {}) =>
  app.inject({
    method: 'POST',
    url: options.url ?? '/api/mock/jofotara/submit',
    headers: { 'content-type': 'application/xml', ...options.headers },
    payload: payload as string,
  });

describe('the document our builder produces', () => {
  it('clears', async () => {
    const response = await submit(realDocument());

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ clearanceStatus: 'CLEARED', errors: [] });
  });

  it('passes every structural check individually', () => {
    // If this fails, the builder and the mock have drifted apart.
    expect(checkStructure(realDocument())).toMatchObject({ ok: true, errors: [] });
  });
});

describe('nothing it returns can pass for a real verdict', () => {
  it('flags every response as a mock', async () => {
    const response = await submit(realDocument());
    /*
     * The expensive failure is a stored CLEARED that nobody can later
     * distinguish from one an authority issued. This flag and the uuid prefix
     * are the two things that make that distinguishable forever.
     */
    expect(response.json().mock).toBe(true);
  });

  it('prefixes its identifiers with mock-', async () => {
    const response = await submit(realDocument());
    expect(response.json().uuid).toMatch(/^mock-\d+-[0-9a-f]+$/);
    expect(response.json().clearanceHash).toMatch(/^mock-hash-/);
  });

  it('emits a QR payload that says what it is when decoded', async () => {
    const qr = (await submit(realDocument())).json().qrCode as string;
    expect(Buffer.from(qr, 'base64').toString('utf8')).toMatch(/not-a-real-jofotara-payload/);
  });
});

describe('structural validation', () => {
  it('rejects an empty body', async () => {
    const result = await submit('');
    expect(result.json().clearanceStatus).toBe('NOT_CLEARED');
    expect(result.json().errors[0].code).toBe('EMPTY_BODY');
  });

  it('rejects a document with no invoice number', async () => {
    const stripped = realDocument().replace(/<cbc:ID>INV-2026-0001<\/cbc:ID>/, '');
    const result = await submit(stripped);

    expect(result.json().clearanceStatus).toBe('NOT_CLEARED');
    expect(result.json().errors.map((e: { code: string }) => e.code)).toContain('MISSING_ID');
  });

  it('rejects a document with no lines', async () => {
    const stripped = realDocument().replace(/<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/, '');
    const result = await submit(stripped);
    expect(result.json().errors.map((e: { code: string }) => e.code)).toContain('NO_LINES');
  });

  it('reports every structural problem at once, not just the first', async () => {
    const result = await submit('<Invoice></Invoice>');
    // A validator that stops at the first error turns one fix into five trips.
    expect(result.json().errors.length).toBeGreaterThan(1);
  });

  it('does not demand cac:Invoice, which UBL never produces', () => {
    /*
     * UBL 2.1 places Invoice in the DEFAULT namespace. A check for
     * `<cac:Invoice>` would reject every correctly-formed document, so this
     * pins that the root check accepts the real shape.
     */
    const check = checkStructure(realDocument());
    expect(check.ok).toBe(true);
    // Note the trailing delimiter: `<cac:InvoiceLine>` legitimately contains
    // the substring `<cac:Invoice`, so a bare `toContain` would fail here for
    // the wrong reason.
    expect(realDocument()).not.toMatch(/<cac:Invoice[\s>]/);
  });
});

describe('driving the outcome', () => {
  it('rejects on request, via query parameter', async () => {
    const result = await submit(realDocument(), { url: '/api/mock/jofotara/submit?status=rejected' });
    expect(result.statusCode).toBe(200);
    expect(result.json().clearanceStatus).toBe('NOT_CLEARED');
    expect(result.json().errors[0].code).toBe('REJECTED_BY_REQUEST');
  });

  it('errors on request, via header', async () => {
    const result = await submit(realDocument(), { headers: { 'x-mock-status': 'error' } });
    expect(result.json().clearanceStatus).toBe('ERROR');
  });

  it('answers ERROR with 5xx and a rejection with 200', async () => {
    /*
     * A rejected invoice is a successfully delivered VERDICT. Returning 5xx for
     * it would send a retry loop at a document the authority has already
     * refused; only a transport/service failure is 5xx.
     */
    const rejected = await submit(realDocument(), { headers: { 'x-mock-status': 'rejected' } });
    const errored = await submit(realDocument(), { headers: { 'x-mock-status': 'error' } });
    expect(rejected.statusCode).toBe(200);
    expect(errored.statusCode).toBe(503);
  });

  it('lets a per-request override beat the environment setting', () => {
    const env = { MOCK_JOFOTARA_MODE: 'always-error' } as NodeJS.ProcessEnv;
    // Otherwise a suite pinned to always-error could never assert the happy path.
    expect(resolveMode({ headers: {}, query: {} }, env)).toBe('error');
    expect(resolveMode({ headers: { 'x-mock-status': 'cleared' }, query: {} }, env)).toBe('cleared');
    expect(resolveMode({ headers: {}, query: { status: 'cleared' } }, env)).toBe('cleared');
  });

  it('ignores a mode it does not recognise rather than failing', () => {
    expect(resolveMode({ headers: { 'x-mock-status': 'banana' }, query: {} }, {})).toBe('cleared');
  });
});

describe('how the document may be sent', () => {
  it('accepts raw XML', async () => {
    expect((await submit(realDocument())).json().clearanceStatus).toBe('CLEARED');
  });

  it('accepts a JSON wrapper, which is easier to drive by hand', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/mock/jofotara/submit',
      payload: { xml: realDocument() },
    });
    expect(result.json().clearanceStatus).toBe('CLEARED');
  });

  it('pulls the document out of either shape', () => {
    expect(extractXml('<Invoice/>')).toBe('<Invoice/>');
    expect(extractXml({ xml: '<Invoice/>' })).toBe('<Invoice/>');
    expect(extractXml({ invoice: '<Invoice/>' })).toBe('<Invoice/>');
    expect(extractXml({ nothing: 1 })).toBe('');
    expect(extractXml(null)).toBe('');
  });
});

describe('latency', () => {
  it('takes long enough to expose a race', async () => {
    const started = Date.now();
    await submit(realDocument());
    /*
     * An instant clearance hides the double-submit, the unmounted-page response
     * and the optimistic render. Slow enough to interleave IS the feature.
     */
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });
});

describe('health', () => {
  it('answers without a document', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/mock/jofotara/health' });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ status: 'ok', mock: true });
  });
});

describe('the production guard', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://localhost/x',
    SESSION_SECRET: 'a-strong-random-value-for-this-test-only',
    APP_BASE_URL: 'https://example.test',
    CORS_ORIGIN: 'https://example.test',
  } as NodeJS.ProcessEnv;

  it('refuses to boot with the mock enabled in production', () => {
    /*
     * Refused, not ignored. Silently disabling it would leave an operator
     * believing clearance was being exercised when nothing was reachable —
     * and, worse, a deployment where it DID answer would write fabricated
     * CLEARED verdicts into a compliance record.
     */
    expect(() => loadConfig({ ...base, MOCK_JOFOTARA: 'true' }))
      .toThrow(/MOCK_JOFOTARA cannot be enabled in production/);
  });

  it('boots in production with it off', () => {
    expect(() => loadConfig({ ...base, MOCK_JOFOTARA: 'false' })).not.toThrow();
  });

  it('allows it outside production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', MOCK_JOFOTARA: 'true' })).not.toThrow();
  });
});
