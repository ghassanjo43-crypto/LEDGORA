// @vitest-environment happy-dom
/**
 * Forgot password, driven through the REAL client stack.
 *
 * Only `fetch` is stubbed. Everything between the rendered card and that call —
 * `LoginPage`, `apiAuthService`, `authApi`, `apiRequest` and `ApiError` shaping —
 * is the production code, so these tests fail if any link in that chain breaks.
 *
 * The claims:
 *
 *   reachable   the recovery form is reachable from the sign-in card, and asks
 *               for the address on its own rather than borrowing the login one;
 *   generic     a registered address and an unregistered one produce the SAME
 *               sentence, and the page never repeats anything more specific the
 *               server might one day start returning;
 *   honest      a request that never reached the server is reported as a
 *               failure, because that is a fact about the browser, not about
 *               whether the account exists;
 *   redemption  the page the emailed link opens still inspects the token, sets
 *               the password and sends the person to sign in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const API = 'https://api.example.test';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The one sentence the backend answers with, whatever the address. */
const GENERIC = 'If an account exists for that address, reset instructions have been sent.';

/** Route-based fetch stub, matched on a URL fragment. */
function mockRoutes(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const hit = Object.keys(routes).find((path) => url.includes(path));
    if (!hit) return json({ error: { code: 'not_found', message: 'No route.' } }, 404);
    return routes[hit]!(init as RequestInit);
  });
}

/**
 * The service registry resolves its adapter at MODULE LOAD from `VITE_API_URL`,
 * so the page has to be imported after the stub is in place.
 */
async function renderLogin() {
  const { LoginPage } = await import('@/pages/onboarding/LoginPage');
  return render(<LoginPage />);
}

/** Open the recovery panel from the sign-in card. */
async function openRecovery() {
  fireEvent.click(screen.getByRole('button', { name: /forgot password\?/i }));
  return screen.findByLabelText(/business email/i);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', API);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reaching the recovery form', () => {
  it(
    'offers a forgot-password control on the sign-in card',
    async () => {
      await renderLogin();
      expect(screen.getByRole('button', { name: /forgot password\?/i })).toBeTruthy();
    },
    // This is the first cold import of the real client stack. On slower Windows
    // runners its transform can exceed Vitest's 5s default; timing out while the
    // import is still resolving also lets its late render contaminate the next
    // test despite cleanup.
    15_000,
  );

  it('opens a form with its own address field, and a way back', async () => {
    await renderLogin();
    fireEvent.change(screen.getByLabelText(/business email/i), { target: { value: 'ada@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /forgot password\?/i }));

    expect(await screen.findByRole('button', { name: /send reset link/i })).toBeTruthy();
    // Whatever was already typed is carried across rather than retyped.
    expect((screen.getByLabelText(/business email/i) as HTMLInputElement).value).toBe('ada@example.test');

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeTruthy();
  });
});

describe('submitting the form', () => {
  it('posts the address to the backend', async () => {
    const fetchSpy = mockRoutes({ '/api/auth/forgot-password': () => json({ ok: true, message: GENERIC }) });

    await renderLogin();
    const field = await openRecovery();
    fireEvent.change(field, { target: { value: 'ada@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/api/auth/forgot-password`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ email: 'ada@example.test' });
  });

  it('shows the same message for a registered and an unregistered address', async () => {
    // The backend answers identically; the assertion is that the PAGE does too.
    mockRoutes({ '/api/auth/forgot-password': () => json({ ok: true, message: GENERIC }) });

    await renderLogin();
    const field = await openRecovery();

    for (const address of ['ada@example.test', 'nobody@nowhere.test']) {
      fireEvent.change(field, { target: { value: address } });
      fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
      expect(await screen.findByText(GENERIC)).toBeTruthy();
    }

    expect(document.body.textContent).not.toMatch(/not found|no account|unregistered|does not exist/i);
  });

  it('does not repeat a more specific answer, even if the server sends one', async () => {
    // Defence in depth: a future endpoint that leaked "no such user" must not be
    // able to make this page leak it too.
    mockRoutes({
      '/api/auth/forgot-password': () => json({ ok: true, message: 'No account exists for ada@example.test.' }),
    });

    await renderLogin();
    fireEvent.change(await openRecovery(), { target: { value: 'ada@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(GENERIC)).toBeTruthy();
    expect(document.body.textContent).not.toContain('No account exists');
  });

  it('reports a request that never reached the server as a failure', async () => {
    // A network failure is a fact about the browser, not about the account, so
    // suppressing it would leave the person believing mail is on its way.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await renderLogin();
    fireEvent.change(await openRecovery(), { target: { value: 'ada@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(screen.queryByText(GENERIC)).toBeNull());
    expect(document.body.textContent).toMatch(/could not|unable|failed|reach/i);
  });

  it('never puts the address in the URL or in browser storage', async () => {
    mockRoutes({ '/api/auth/forgot-password': () => json({ ok: true, message: GENERIC }) });

    await renderLogin();
    fireEvent.change(await openRecovery(), { target: { value: 'ada@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    await screen.findByText(GENERIC);

    expect(window.location.search).toBe('');
    expect(JSON.stringify(localStorage)).not.toContain('ada@example.test');
    expect(JSON.stringify(sessionStorage)).not.toContain('ada@example.test');
  });
});

/* ══ The page the emailed link opens ═════════════════════════════════════ */

describe('the reset page the email links to', () => {
  const TOKEN = 'emailed-token-value-with-enough-length';

  beforeEach(() => {
    window.history.replaceState({}, '', `/set-password?token=${encodeURIComponent(TOKEN)}`);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  async function renderAccept() {
    const { AcceptInvitationPage } = await import('@/pages/AcceptInvitationPage');
    return render(<AcceptInvitationPage />);
  }

  it('inspects the emailed token by POST, never by putting it in a query to the API', async () => {
    const fetchSpy = mockRoutes({
      '/api/auth/invitation/inspect': () =>
        json({ valid: true, purpose: 'reset', maskedEmail: 'a**@example.test', expiresAt: null }),
    });

    await renderAccept();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/api/auth/invitation/inspect`);
    expect(String(url)).not.toContain(TOKEN);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ token: TOKEN });
    // A reset link says "choose a new password"; an invitation says "set your".
    expect(await screen.findByText(/choose a new password/i)).toBeTruthy();
    expect(screen.getByText(/a\*\*@example\.test/)).toBeTruthy();
  });

  it('sets the password with the emailed token and sends the person to sign in', async () => {
    const fetchSpy = mockRoutes({
      '/api/auth/invitation/inspect': () =>
        json({ valid: true, purpose: 'reset', maskedEmail: 'a**@example.test', expiresAt: null }),
      '/api/auth/reset-password': () =>
        json({ ok: true, email: 'ada@example.test', purpose: 'reset', message: 'Your password has been set.' }),
    });

    const { container } = await renderAccept();
    await screen.findByText(/choose a new password/i);

    // The two password fields, in the order the form renders them. Selected by
    // type rather than by label because this page's `Field` labels are not
    // `htmlFor`-associated — a separate defect, not this flow's.
    const [next, confirm] = Array.from(container.querySelectorAll('input[type="password"]'));
    fireEvent.change(next!, { target: { value: 'Bright-Harbour-58-Zq' } });
    fireEvent.change(confirm!, { target: { value: 'Bright-Harbour-58-Zq' } });
    fireEvent.click(screen.getByRole('button', { name: /set password/i }));

    expect(await screen.findByText(/your password has been set/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /continue to sign in/i })).toBeTruthy();

    const redeem = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/auth/reset-password'))!;
    expect(JSON.parse(String((redeem[1] as RequestInit).body))).toEqual({
      token: TOKEN,
      newPassword: 'Bright-Harbour-58-Zq',
    });

    // The token is scrubbed from the address bar rather than left in history.
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('gives one refusal for an expired, used or invented link', async () => {
    mockRoutes({
      '/api/auth/invitation/inspect': () =>
        json({ valid: false, purpose: null, maskedEmail: null, expiresAt: null }),
    });

    await renderAccept();
    expect(await screen.findByText(/this link is no longer valid/i)).toBeTruthy();
    // Nothing distinguishes the causes.
    expect(document.body.textContent).not.toMatch(/expired on|already used at|revoked by/i);
  });
});
