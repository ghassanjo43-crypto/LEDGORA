/**
 * Payment-proof file storage.
 *
 * File bytes NEVER go into PostgreSQL — the database holds an opaque
 * `storage_key` only. `FileStorage` is the seam an object-storage backend
 * implements; the local adapter below is for development and single-instance
 * deployments.
 *
 * ── BACKEND SEAM ──────────────────────────────────────────────────────────────
 * Implement `FileStorage` against S3 / Cloudflare R2 / Render Disks:
 *   put()    → PutObject
 *   get()    → GetObject
 *   delete() → DeleteObject
 *   url()    → a short-lived pre-signed URL (never a public one — payment
 *              receipts are personal financial documents)
 * Then swap the export in `storage/index.ts`. Nothing else changes.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { generateStorageKey } from '../lib/tokens.js';
import { errors } from '../lib/errors.js';

/** Receipts only. Anything executable or scriptable is refused. */
export const ALLOWED_PROOF_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Magic bytes, so a renamed executable cannot pass as a receipt. */
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

export interface StoredFile {
  storageKey: string;
  size: number;
  mimeType: string;
}

export interface FileStorage {
  put(input: { content: Buffer; mimeType: string }): Promise<StoredFile>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}

/** Content-type claim AND magic bytes must agree. */
export function assertAcceptableProof(content: Buffer, declaredMime: string, maxBytes: number): void {
  if (!ALLOWED_PROOF_MIME_TYPES.includes(declaredMime as (typeof ALLOWED_PROOF_MIME_TYPES)[number])) {
    throw errors.validation('Only PNG, JPEG, WEBP or PDF receipts are accepted.');
  }
  if (content.length === 0) throw errors.validation('The uploaded file is empty.');
  if (content.length > maxBytes) {
    throw errors.validation(`The file is larger than the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
  }

  const signature = SIGNATURES.find((s) => s.mime === declaredMime);
  if (signature) {
    const matches = signature.bytes.every((byte, index) => content[index] === byte);
    if (!matches) {
      // The extension/content-type says one thing, the bytes say another.
      throw errors.validation('The file content does not match its declared type.');
    }
  }
}

/**
 * Local filesystem adapter.
 *
 * Keys are server-generated random hex — no user-supplied path component ever
 * reaches the filesystem. `resolveKey` additionally re-checks that the resolved
 * path stays inside the root, so even a crafted key cannot traverse out.
 */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly rootDirectory: string) {}

  private resolveKey(storageKey: string): string {
    // Reject anything that is not a bare generated key before touching the FS.
    if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/i.test(storageKey)) {
      throw errors.validation('Invalid storage key.');
    }
    const root = path.resolve(this.rootDirectory);
    const resolved = path.resolve(root, storageKey);
    // Defence in depth against path traversal.
    if (resolved !== path.join(root, path.basename(resolved))) {
      throw errors.validation('Invalid storage key.');
    }
    if (!resolved.startsWith(root + path.sep)) {
      throw errors.validation('Invalid storage key.');
    }
    return resolved;
  }

  async put({ content, mimeType }: { content: Buffer; mimeType: string }): Promise<StoredFile> {
    const storageKey = generateStorageKey(EXTENSION_BY_MIME[mimeType] ?? 'bin');
    const target = this.resolveKey(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
    return { storageKey, size: content.length, mimeType };
  }

  async get(storageKey: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveKey(storageKey));
    } catch {
      throw errors.notFound('Stored file');
    }
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await unlink(this.resolveKey(storageKey));
    } catch {
      /* already gone */
    }
  }
}

/** In-memory adapter for tests — no filesystem involvement at all. */
export class MemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, Buffer>();

  async put({ content, mimeType }: { content: Buffer; mimeType: string }): Promise<StoredFile> {
    const storageKey = generateStorageKey(EXTENSION_BY_MIME[mimeType] ?? 'bin');
    this.files.set(storageKey, content);
    return { storageKey, size: content.length, mimeType };
  }

  async get(storageKey: string): Promise<Buffer> {
    const file = this.files.get(storageKey);
    if (!file) throw errors.notFound('Stored file');
    return file;
  }

  async delete(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }

  get size(): number {
    return this.files.size;
  }
}
