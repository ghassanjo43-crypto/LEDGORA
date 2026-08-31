/**
 * Which backend holds a company's invoices.
 *
 * ══ One verdict, not two ═════════════════════════════════════════════════════
 *
 * This used to derive the answer from a per-company `invoicesMigratedAt`
 * timestamp, set by a cutover that imported the browser's invoices. Nothing ever
 * wrote that timestamp — the cutover had no caller — so the answer was always
 * `browser` and the server invoice path was unreachable in production.
 *
 * The migration it existed for is not happening: browser invoices are disposable
 * test records and are not imported. So the verdict is now the SAME latched
 * decision the chart of accounts, the journal and the customer directory use. A
 * workspace cannot have its books on the server and its invoices in the browser,
 * which is what kept two invoice-number allocators alive at once — one under an
 * advisory lock on the server, one counting `usedNumbers()` in a tab, neither
 * able to see the other.
 */
import { booksEngine } from '@/services/books/booksEngine';

export type InvoiceBackend = 'browser' | 'server';

export function invoiceBackend(): InvoiceBackend {
  return booksEngine() === 'server' ? 'server' : 'browser';
}
