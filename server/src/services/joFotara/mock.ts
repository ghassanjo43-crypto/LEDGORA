/**
 * A stand-in for JoFotara's clearance endpoint.
 *
 * ══ What this is for ═════════════════════════════════════════════════════════
 *
 * Exercising OUR submission path — building the XML, posting it, parsing a
 * response, storing the result, showing a rejection to a user — without ISTD
 * credentials and without touching a tax authority's test environment.
 *
 * ══ What this is NOT ═════════════════════════════════════════════════════════
 *
 * It is not a JoFotara emulator, and passing it means nothing about whether a
 * real submission would clear. Its validation is STRUCTURAL: does this look
 * like a UBL invoice at all. Every genuine rule — the income source sequence,
 * the customization identifier, tax category codes, the signature — is
 * unknowable until the specification is in hand, and a mock that guessed at
 * them would be worse than one that does not, because it would produce
 * confident green results for documents the authority rejects.
 *
 * ══ Why the guards are as heavy as they are ══════════════════════════════════
 *
 * The failure this is built to prevent is not a wrong response. It is a stored
 * `CLEARED` that nobody can later distinguish from a real one. Hence: refused
 * outright in production (`config/env.ts`), `mock-` prefixed identifiers, a
 * `mock: true` flag on every response, and a loud warning at registration.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ClearanceError, ClearanceResponse, MockMode } from './contract.js';
import { isMockMode } from './contract.js';

/* ══ Latency ═══════════════════════════════════════════════════════════════ */

const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 500;

/**
 * Simulated round-trip time.
 *
 * Not decoration. A clearance call that returns instantly hides every race a
 * real one exposes — the double-submit from an impatient user, the request
 * still in flight when the page unmounts, the optimistic UI that renders
 * "cleared" before it is. Making the mock slow enough to interleave is the
 * point of it.
 */
function latency(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ══ Structural validation ═════════════════════════════════════════════════ */

export interface StructuralCheck {
  ok: boolean;
  errors: ClearanceError[];
}

/**
 * Does this look like a UBL 2.1 Invoice?
 *
 * Deliberately string matching rather than XML parsing. Adding a parser here
 * would invite the mock to grow into a validator, which is precisely the thing
 * that would make its green results misleading. These checks catch the errors
 * an integration actually makes early on — an empty body, a JSON payload sent
 * by mistake, a document missing its identifier — and nothing subtler.
 *
 * Note on the root element: UBL 2.1 puts `Invoice` in the DEFAULT namespace
 * (`urn:...:Invoice-2`), NOT in `cac:`. `cac:` is CommonAggregateComponents and
 * holds things like `cac:InvoiceLine`. A check for `<cac:Invoice>` would reject
 * every correctly-formed document, so this looks for `<Invoice` and tolerates
 * an arbitrary prefix for the unusual case where one is bound.
 */
export function checkStructure(xml: string): StructuralCheck {
  const errors: ClearanceError[] = [];
  const has = (needle: RegExp): boolean => needle.test(xml);

  if (xml.trim() === '') {
    return { ok: false, errors: [{ code: 'EMPTY_BODY', message: 'No document was submitted.' }] };
  }

  if (!has(/<(?:[A-Za-z0-9_.-]+:)?Invoice[\s>]/)) {
    errors.push({
      code: 'MISSING_ROOT',
      message: 'The document has no <Invoice> root element. UBL 2.1 places Invoice in the default namespace, not in cac:.',
    });
  }
  /*
   * `cbc:ID` is NOT unique in a UBL invoice: every line has one, so does every
   * tax category and tax scheme. Searching the whole document would pass a
   * document with no invoice number at all, as long as it had a single line.
   *
   * The invoice's own identifier is the one in the header, before the first
   * aggregate (`cac:`) element, so that is the only region searched.
   */
  const header = xml.split(/<cac:/)[0] ?? '';
  if (!/<cbc:ID>[^<]+<\/cbc:ID>/.test(header)) {
    errors.push({ code: 'MISSING_ID', message: 'The invoice has no document-level cbc:ID (invoice number).' });
  }
  if (!has(/<cbc:IssueDate>\d{4}-\d{2}-\d{2}<\/cbc:IssueDate>/)) {
    errors.push({ code: 'MISSING_ISSUE_DATE', message: 'The invoice has no valid cbc:IssueDate (YYYY-MM-DD).' });
  }
  if (!has(/<cac:AccountingSupplierParty>/)) {
    errors.push({ code: 'MISSING_SUPPLIER', message: 'The invoice has no cac:AccountingSupplierParty.' });
  }
  if (!has(/<cac:InvoiceLine>/)) {
    errors.push({ code: 'NO_LINES', message: 'The invoice has no cac:InvoiceLine.' });
  }
  if (!has(/<cac:LegalMonetaryTotal>/)) {
    errors.push({ code: 'MISSING_TOTALS', message: 'The invoice has no cac:LegalMonetaryTotal.' });
  }

  return { ok: errors.length === 0, errors };
}

/* ══ Response construction ════════════════════════════════════════════════ */

/** Every identifier the mock issues is self-identifying. */
function mockUuid(): string {
  return `mock-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * A placeholder QR payload.
 *
 * Real JoFotara QR content is a defined byte structure the specification
 * describes; this is base64 of a sentence saying so, which renders as a
 * scannable-looking string and is obviously wrong to anyone who decodes it.
 */
function mockQrCode(invoiceId: string): string {
  return Buffer.from(`MOCK-QR|${invoiceId}|not-a-real-jofotara-payload`, 'utf8').toString('base64');
}

function mockHash(xml: string): string {
  // Deliberately not a real digest: a plausible-looking SHA-256 would invite
  // somebody to verify against it.
  return `mock-hash-${xml.length.toString(16)}-${randomUUID().slice(0, 12)}`;
}

export function buildResponse(mode: MockMode, xml: string, structure: StructuralCheck): ClearanceResponse {
  const base = { uuid: mockUuid(), qrCode: mockQrCode('mock'), clearanceHash: mockHash(xml), mock: true as const };

  if (mode === 'error') {
    return {
      ...base,
      clearanceStatus: 'ERROR',
      errors: [{ code: 'UPSTREAM_UNAVAILABLE', message: 'The clearance service is temporarily unavailable. (mock)' }],
    };
  }
  if (mode === 'rejected' || !structure.ok) {
    return {
      ...base,
      clearanceStatus: 'NOT_CLEARED',
      errors: structure.ok
        ? [{ code: 'REJECTED_BY_REQUEST', message: 'Rejected because the mock was asked to reject. (mock)' }]
        : structure.errors,
    };
  }
  return { ...base, clearanceStatus: 'CLEARED', errors: [] };
}

/* ══ Request handling ═════════════════════════════════════════════════════ */

/**
 * Pull the XML out, whichever way it was sent.
 *
 * Raw `application/xml` is what a real client sends; the JSON wrapper exists
 * because it is far easier to drive from a test or a REST client by hand.
 */
export function extractXml(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const wrapper = body as { xml?: unknown; invoice?: unknown };
    if (typeof wrapper.xml === 'string') return wrapper.xml;
    if (typeof wrapper.invoice === 'string') return wrapper.invoice;
  }
  return '';
}

/**
 * Which behaviour was requested.
 *
 * Precedence is most-specific-wins: an explicit header or query parameter on
 * ONE request beats a process-wide environment setting, so a suite pinned to
 * `always-error` can still assert the success path. `always-error` is spelled
 * as the brief specified it and normalised here.
 */
export function resolveMode(request: {
  query?: unknown;
  headers?: Record<string, unknown>;
}, env: NodeJS.ProcessEnv = process.env): MockMode {
  const header = request.headers?.['x-mock-status'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (isMockMode(headerValue)) return headerValue;

  const query = (request.query ?? {}) as { status?: unknown };
  if (isMockMode(query.status)) return query.status;

  if (env.MOCK_JOFOTARA_MODE === 'always-error') return 'error';
  if (env.MOCK_JOFOTARA_MODE === 'always-rejected') return 'rejected';
  return 'cleared';
}

/* ══ Routes ═══════════════════════════════════════════════════════════════ */

export async function joFotaraMockRoutes(app: FastifyInstance): Promise<void> {
  /*
   * A real client posts `application/xml`, which Fastify has no parser for.
   * Registered narrowly here rather than globally: nothing else in this API
   * accepts XML, and a global parser would silently accept it everywhere.
   */
  for (const contentType of ['application/xml', 'text/xml'] as const) {
    app.addContentTypeParser(contentType, { parseAs: 'string' }, (_request, body, done) => {
      done(null, typeof body === 'string' ? body : '');
    });
  }

  app.get('/api/mock/jofotara/health', async (_request, reply) =>
    reply.send({ status: 'ok', mock: true }),
  );

  app.post('/api/mock/jofotara/submit', async (request: FastifyRequest, reply) => {
    const xml = extractXml(request.body);
    const mode = resolveMode(request);
    const structure = checkStructure(xml);

    request.log.info(
      {
        mock: 'jofotara',
        mode,
        bytes: xml.length,
        structurallyValid: structure.ok,
        // The document itself is NOT logged: an invoice carries a customer's
        // name, address and tax number, and a debug log is the wrong home for
        // it even in development.
        invoiceNumber: /<cbc:ID>([^<]+)<\/cbc:ID>/.exec(xml)?.[1] ?? null,
      },
      'jofotara mock: submission received',
    );

    await sleep(latency());

    const response = buildResponse(mode, xml, structure);

    request.log.info(
      { mock: 'jofotara', status: response.clearanceStatus, uuid: response.uuid, errors: response.errors.length },
      'jofotara mock: responding',
    );

    /*
     * HTTP status mirrors what a caller must handle, not the clearance outcome.
     * A rejected invoice is a successfully-delivered verdict — 200 — because
     * treating it as a transport failure would send a retry loop at a document
     * the authority has already refused. Only ERROR is 5xx.
     */
    return reply.code(response.clearanceStatus === 'ERROR' ? 503 : 200).send(response);
  });
}
