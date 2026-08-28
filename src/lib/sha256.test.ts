import { describe, it, expect } from 'vitest';
import { sha256Hex } from './sha256';

/**
 * FIPS 180-4 / NIST published vectors.
 *
 * These matter more than a typical unit test: this digest is stored as legal
 * evidence, and its whole value is that a third party can reproduce it with
 * `sha256sum`. If this implementation disagreed with the standard by one bit,
 * every acceptance record would be unverifiable by anyone outside this codebase
 * — while still looking perfectly consistent inside it.
 */
describe('sha256Hex', () => {
  it('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex(
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    )).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('matches the vector that crosses a padding block boundary', () => {
    /* 'a' × 1,000,000 is the classic long vector; 55/56/64 bytes are where
       naive padding implementations break. */
    expect(sha256Hex('a'.repeat(55))).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318');
    expect(sha256Hex('a'.repeat(56))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a');
    expect(sha256Hex('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
  });

  it('handles non-ASCII text, which legal documents contain', () => {
    /*
     * Typographic dashes and Arabic appear throughout the Terms, and an Arabic
     * legal version is expected later. These digests were produced INDEPENDENTLY
     * by Node's own `crypto` (`createHash('sha256').update(s,'utf8')`), so they
     * catch a UTF-8 regression rather than merely confirming this module agrees
     * with itself.
     */
    expect(sha256Hex('café')).toBe('850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e');
    expect(sha256Hex('a—b')).toBe('705b80b543dd8a16ff83021e9de631d32a04cff5e5815df112e1c7a81b0615c9');
    expect(sha256Hex('مرحبا')).toBe('80eff1a750bb540045622ad23c148c8875790515e3f768c77d5dff8c1d221b49');
  });

  it('produces 64 lower-case hex characters for any input', () => {
    for (const input of ['', 'x', 'a'.repeat(1000), 'مرحبا']) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
