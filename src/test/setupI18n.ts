/**
 * Initialise i18next once for the whole suite.
 *
 * ── Why this is a global setup and not a per-test wrapper ────────────────────
 * `useTranslation` returns the KEY when i18next has not been initialised, so a
 * component under test renders "signIn.email" where it should render "Business
 * email" — and every `getByLabelText` against real copy fails. As the app is
 * translated component by component, that would break the existing tests of
 * each one in turn, and the fix would be to wrap ~230 test files in a provider
 * they do not otherwise need.
 *
 * Initialising here instead means a translated component behaves in tests
 * exactly as it does in the app: English by default, real strings, no wrapper.
 *
 * Tests that specifically exercise LANGUAGE behaviour still render
 * `<LanguageProvider>` themselves — it is what supplies direction and the
 * numeral/calendar preferences, which this does not.
 */
import { initI18n } from '@/i18n';

initI18n('en');
