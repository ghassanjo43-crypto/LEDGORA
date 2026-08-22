import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './client';

describe('resolveApiBaseUrl', () => {
  it('follows the actual Vite origin when legacy localhost :5173 moves to a free port', () => {
    expect(resolveApiBaseUrl('http://localhost:5173', 'http://localhost:5174', true))
      .toBe('http://localhost:5174');
  });

  it('keeps the preferred localhost origin when Vite is still on 5173', () => {
    expect(resolveApiBaseUrl('http://localhost:5173', 'http://localhost:5173', true))
      .toBe('http://localhost:5173');
  });

  it('does not rewrite an explicit API port or a deployed origin', () => {
    expect(resolveApiBaseUrl('http://localhost:3000', 'http://localhost:5174', true))
      .toBe('http://localhost:3000');
    expect(resolveApiBaseUrl('https://api.ledgora.example', 'https://app.ledgora.example', false))
      .toBe('https://api.ledgora.example');
  });
});
