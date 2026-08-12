// @vitest-environment happy-dom
/**
 * Company creation must capture a functional currency.
 *
 * The field it replaced was a nine-item `<select>` defaulting to USD, so the
 * commonest outcome was a company keeping its books in a currency nobody chose.
 * These tests hold the form to the opposite: the currency is REQUIRED, it is
 * chosen from the canonical catalogue, and what gets persisted is the ISO code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingOrganizationPage } from './OnboardingOrganizationPage';
import { useOrganizationStore } from '@/store/organizationStore';
import { useCurrencyStore } from '@/store/currencyStore';
import { useAuthStore } from '@/store/authStore';
import { useStore, DEFAULT_SETTINGS } from '@/store/useStore';
import { SEED_CURRENCIES } from '@/data/currencySeed';

const currencyTrigger = (): HTMLElement =>
  screen.getByLabelText('Base / functional currency', { selector: 'button' });
const panelSearch = (): HTMLInputElement =>
  screen.getByLabelText('Search currencies') as HTMLInputElement;
/** The clickable option buttons — the <li role="option"> wrapper is inert. */
const optionButtons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"] button'));
const options = (): string[] => optionButtons().map((o) => (o.textContent ?? '').trim());
const pickOption = (code: string): void => {
  const btn = optionButtons().find((o) => (o.textContent ?? '').includes(code));
  if (!btn) throw new Error(`no option for ${code}`);
  fireEvent.click(btn);
};

function openPicker(): void {
  fireEvent.click(currencyTrigger());
}

beforeEach(() => {
  useCurrencyStore.setState({ currencies: SEED_CURRENCIES } as never);
  useOrganizationStore.setState({ organization: null } as never);
  useAuthStore.setState({ currentUserId: null } as never);
  useStore.setState({ settings: DEFAULT_SETTINGS });
});
afterEach(cleanup);

describe('the company creation form', () => {
  it('1 · offers the functional currency as a required field with no default', () => {
    render(<OnboardingOrganizationPage />);
    const trigger = currencyTrigger();
    expect(trigger).toBeTruthy();
    // Nothing preselected — the user must choose.
    expect(trigger.textContent).toMatch(/Search by code|Select currency|—/i);
    expect(trigger.textContent).not.toMatch(/USD/);
  });

  it('1 · refuses to submit without one', async () => {
    render(<OnboardingOrganizationPage />);
    fireEvent.change(document.querySelector<HTMLInputElement>('input')!, { target: { value: 'Acme Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: /continue|save|next/i }));

    await waitFor(() =>
      expect(document.body.textContent).toMatch(/Select the base \/ functional currency/i),
    );
    expect(useOrganizationStore.getState().organization).toBeNull();
  });

  it('2 · the picker is searchable over the whole catalogue, not a short list', () => {
    render(<OnboardingOrganizationPage />);
    openPicker();
    // Far more than the nine the old <select> offered.
    expect(options().length).toBeGreaterThan(100);
  });

  it('3–5 · finds JOD by code, by name and case-insensitively', () => {
    render(<OnboardingOrganizationPage />);
    openPicker();

    fireEvent.change(panelSearch(), { target: { value: 'JOD' } });
    expect(options().some((t) => /JOD/.test(t) && /Jordanian Dinar/.test(t))).toBe(true);

    fireEvent.change(panelSearch(), { target: { value: 'dinar' } });
    const dinars = options().join(' ');
    expect(dinars).toMatch(/Jordanian Dinar/);
    expect(dinars).toMatch(/Kuwaiti Dinar/);

    fireEvent.change(panelSearch(), { target: { value: 'jordan' } });
    expect(options().some((t) => /Jordanian Dinar/.test(t))).toBe(true);
  });

  it('6–7 · JOD and the other named currencies can be selected', () => {
    render(<OnboardingOrganizationPage />);
    for (const code of ['JOD', 'USD', 'EUR', 'GBP', 'AED', 'SAR']) {
      openPicker();
      fireEvent.change(panelSearch(), { target: { value: code } });
      expect(optionButtons().some((o) => (o.textContent ?? '').includes(code)), `${code} is offered`).toBe(true);
      pickOption(code);
      expect(currencyTrigger().textContent, `${code} is selected`).toContain(code);
    }
  });

  it('5 · a country selection suggests the usual currency but never forces it', () => {
    render(<OnboardingOrganizationPage />);
    const country = document.querySelectorAll('select')[0] as HTMLSelectElement;

    fireEvent.change(country, { target: { value: 'JO' } });
    expect(currencyTrigger().textContent, 'Jordan suggests JOD').toContain('JOD');

    // The user overrides it — a Jordanian company may report in USD.
    openPicker();
    fireEvent.change(panelSearch(), { target: { value: 'USD' } });
    pickOption('USD');
    expect(currencyTrigger().textContent).toContain('USD');

    // Changing the country again must NOT overwrite the deliberate choice.
    fireEvent.change(country, { target: { value: 'AE' } });
    expect(currencyTrigger().textContent, 'a suggestion never overwrites a choice').toContain('USD');
  });

  it('8 · hands the canonical store the ISO CODE, not the display label', async () => {
    /*
     * Asserted on the payload the form submits rather than on the persisted
     * record: submission continues into the subscription API, and what this
     * test is about is which value the form carries — the code, never the name.
     */
    const submitted: Array<Record<string, unknown>> = [];
    const real = useOrganizationStore.getState().createOrganization;
    useOrganizationStore.setState({
      createOrganization: (input: Parameters<typeof real>[0]) => {
        submitted.push(input as unknown as Record<string, unknown>);
        return real(input);
      },
    } as never);

    render(<OnboardingOrganizationPage />);
    fireEvent.change(document.querySelector<HTMLInputElement>('input')!, { target: { value: 'Acme Jordan' } });
    fireEvent.change(document.querySelectorAll('select')[0] as HTMLSelectElement, { target: { value: 'JO' } });

    openPicker();
    fireEvent.change(panelSearch(), { target: { value: 'JOD' } });
    pickOption('JOD');
    fireEvent.click(screen.getByRole('button', { name: /continue|save|next/i }));

    await waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    expect(submitted[0]!.baseCurrency).toBe('JOD');
    expect(submitted[0]!.baseCurrency).not.toBe('Jordanian Dinar');
  });
});
