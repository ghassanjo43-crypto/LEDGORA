// @vitest-environment happy-dom
/**
 * The public legal surface: what a signed-out visitor can reach, what a draft
 * shows them, and what the sign-in page says.
 *
 * ══ The rule under test ══════════════════════════════════════════════════════
 *
 * Draft text with `[UNRESOLVED]` placeholders must never reach a public
 * production route. A reader has no way to tell a placeholder from a term, and
 * a competitor reads commercial terms that are not settled. So the public route
 * serves published documents only; everyone else gets a short notice; and a
 * reviewer with explicit entitlement gets the draft behind a banner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TermsPage } from './TermsPage';
import { LegalNotice, privacyPolicyExists } from '@/components/legal/LegalNotice';
import { ROUTES, PUBLIC_PATHS } from '@/lib/accessControl';
import { ALL_LEGAL_DOCUMENTS, legalSurfaceIsLive } from '@/lib/legalDocuments';
import { useRouterStore } from '@/store/routerStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAuthStore } from '@/store/authStore';
import * as legalPreview from '@/lib/legalPreview';

const at = (path: string) => useRouterStore.setState({ path, query: {} });

beforeEach(() => {
  useAuthStore.setState({ users: [], currentUserId: undefined });
  useBackendSessionStore.setState({ platformRoles: [] });
  useSessionStore.setState({ platformRole: 'none' });
  at(ROUTES.terms);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/* ══ The documents are drafts today ════════════════════════════════════════ */

describe('while every document is a draft', () => {
  it('the legal surface is not live', () => {
    expect(legalSurfaceIsLive()).toBe(false);
  });

  it('the sign-in legal line renders NOTHING — no link to an unpublished page', () => {
    const { container } = render(<LegalNotice />);
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('legal-notice')).toBeNull();
  });

  it('never offers a Privacy Policy link, because there is no Privacy Policy', () => {
    expect(privacyPolicyExists).toBe(false);
    render(<LegalNotice />);
    expect(screen.queryByText(/privacy policy/i)).toBeNull();
  });
});

/* ══ The public route while unpublished ════════════════════════════════════ */

describe('the public Terms route, signed out, with drafts unpublished', () => {
  /*
   * The suite runs as an approved local development machine, so drafts would be
   * previewable by default. These cases are about the PUBLIC production route,
   * where nobody is entitled to preview.
   */
  beforeEach(() => {
    vi.spyOn(legalPreview, 'canPreviewLegalDrafts').mockReturnValue(false);
  });

  it('serves a "not published" notice instead of the text', () => {
    render(<TermsPage />);
    expect(screen.getByText(/has not been published yet/i)).toBeTruthy();
    expect(screen.getByText(/no version of it is currently in force/i)).toBeTruthy();
  });

  it('does NOT leak a single unresolved placeholder', () => {
    for (const path of [ROUTES.terms, ROUTES.termsUae, ROUTES.termsJordan, ROUTES.termsSaudi]) {
      at(path);
      const { container, unmount } = render(<TermsPage />);
      expect(screen.queryAllByTestId('legal-unresolved')).toHaveLength(0);
      expect(container.textContent).not.toMatch(/UNRESOLVED/);
      unmount();
    }
  });

  it('still offers navigation to all three addenda', () => {
    render(<TermsPage />);
    const nav = screen.getByRole('navigation', { name: /legal documents/i });
    expect(within(nav).getByText('Master Terms')).toBeTruthy();
    expect(within(nav).getByText(/United Arab Emirates Addendum/)).toBeTruthy();
    expect(within(nav).getByText(/Hashemite Kingdom of Jordan Addendum/)).toBeTruthy();
    expect(within(nav).getByText(/Kingdom of Saudi Arabia Addendum/)).toBeTruthy();
  });

  it('is reachable with no session at all', () => {
    for (const path of [ROUTES.terms, ROUTES.termsUae, ROUTES.termsJordan, ROUTES.termsSaudi]) {
      expect(PUBLIC_PATHS.includes(path)).toBe(true);
    }
    expect(useAuthStore.getState().currentUserId).toBeUndefined();
    render(<TermsPage />);
    expect(screen.getByRole('navigation', { name: /legal documents/i })).toBeTruthy();
  });

  it('states that the country is selected, never inferred', () => {
    render(<TermsPage />);
    expect(screen.getByText(/never inferred from your location, language or currency/i)).toBeTruthy();
  });

  it('asks the visitor for no country — that is not a sign-in question', () => {
    render(<TermsPage />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});

/* ══ The draft preview ═════════════════════════════════════════════════════ */

describe('the draft preview, for an entitled reviewer', () => {
  beforeEach(() => {
    vi.spyOn(legalPreview, 'canPreviewLegalDrafts').mockReturnValue(true);
  });

  it('shows the draft behind an unmissable NOT IN FORCE banner', () => {
    render(<TermsPage />);
    /* Both the banner and the document's own status badge say it — deliberately. */
    expect(screen.getAllByText(/draft — not in force/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/binds nobody/i)).toBeTruthy();
    expect(screen.getByText(/No acceptance is recorded from this screen/i)).toBeTruthy();
  });

  it('shows the unresolved items rather than hiding them from the reviewer', () => {
    render(<TermsPage />);
    expect(screen.getAllByTestId('legal-unresolved').length).toBeGreaterThan(0);
  });

  it('shows the provenance a reviewer needs: version, hash and why it is blocked', () => {
    render(<TermsPage />);
    expect(screen.getByText(/SHA-256 [0-9a-f]{64}/)).toBeTruthy();
    expect(screen.getByText(/Why this is not published/i)).toBeTruthy();
    expect(screen.getByText(/Review required:/i)).toBeTruthy();
  });

  it('previewing changes nothing — no acceptance, no gate, no approval', () => {
    render(<TermsPage />);
    /* The documents are untouched by having been looked at. */
    for (const document of ALL_LEGAL_DOCUMENTS) {
      expect(document.counselApproved).toBe(false);
      expect(document.publicationApproved).toBe(false);
    }
    expect(legalSurfaceIsLive()).toBe(false);
  });
});

/* ══ Entitlement to preview ════════════════════════════════════════════════ */

describe('who may preview a draft', () => {
  it('refuses an ordinary signed-in subscriber', () => {
    /*
     * `platformAdminToolsAllowed` is true under Vitest (the suite runs as an
     * approved local development machine), so this asserts the SESSION half:
     * an ordinary user holds no platform capability.
     */
    useBackendSessionStore.setState({ platformRoles: [] });
    useSessionStore.setState({ platformRole: 'none' });
    vi.spyOn(legalPreview, 'canPreviewLegalDrafts').mockRestore();
    /* Simulate a production build, where the dev opt-in is absent. */
    vi.stubEnv('DEV', false);
    expect(legalPreview.canPreviewLegalDrafts()).toBe(false);
    vi.unstubAllEnvs();
  });

  it('allows a backend-verified super admin', () => {
    vi.stubEnv('DEV', false);
    useBackendSessionStore.setState({ platformRoles: ['super_admin'] });
    expect(legalPreview.canPreviewLegalDrafts()).toBe(true);
    vi.unstubAllEnvs();
  });
});
