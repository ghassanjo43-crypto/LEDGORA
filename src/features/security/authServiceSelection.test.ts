import { afterEach, describe, expect, it, vi } from 'vitest';

const API = 'https://api.example.test';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('authentication adapter selection', () => {
  it('uses the API adapter when a backend origin is configured', async () => {
    vi.stubEnv('VITE_API_URL', API);
    const [{ authService }, { apiAuthService }] = await Promise.all([
      import('@/services'),
      import('@/services/apiAuthService'),
    ]);
    expect(authService).toBe(apiAuthService);
  }, 15_000);

  it('keeps the browser-only adapter when no backend is configured', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const [{ authService }, { devAuthService }] = await Promise.all([
      import('@/services'),
      import('@/services/devAuthService'),
    ]);
    expect(authService).toBe(devAuthService);
  }, 15_000);
});
