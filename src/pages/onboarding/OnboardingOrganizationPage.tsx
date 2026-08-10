/**
 * Organization onboarding. Collects the legal/trading name, country,
 * registration + tax numbers, industry, base currency and financial-year
 * settings, then creates the organization with the current user as owner and
 * advances to subscription selection.
 *
 * Ordering matters and is deliberate: the organization is created on the
 * BACKEND, the returned record is adopted into the store, and only then does
 * the page navigate. Navigating first and hydrating afterwards is what left the
 * subscription page insisting "Create your organization first." about an
 * organization that already existed.
 */
import { useState } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard, Stepper } from '@/components/onboarding/OnboardingChrome';
import { COUNTRY_OPTIONS, FY_START_OPTIONS } from '@/lib/onboardingData';
import { INDUSTRY_OPTIONS, CURRENCY_OPTIONS } from '@/data/ifrsOptions';
import { ROUTES } from '@/lib/accessControl';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { subscriptionApi } from '@/services/api/authApi';
import { ApiError, isApiConfigured } from '@/services/api/client';

const industryOptions = INDUSTRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
const currencyOptions = CURRENCY_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

export function OnboardingOrganizationPage() {
  const createOrganization = useOrganizationStore((s) => s.createOrganization);
  const adoptBackendOrganization = useOrganizationStore((s) => s.adoptBackendOrganization);
  const hydrateFromBackend = useOrganizationStore((s) => s.hydrateFromBackend);
  const navigate = useRouterStore((s) => s.navigate);
  const planCode = useRouterStore((s) => s.query.plan);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    legalName: '',
    tradingName: '',
    country: '',
    registrationNumber: '',
    taxNumber: '',
    industry: 'general',
    baseCurrency: 'USD',
    fiscalYearStart: '01-01',
    booksStartDate: `${new Date().getFullYear()}-01-01`,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const nextRoute = (): string =>
    planCode ? `${ROUTES.onboardingSubscription}?plan=${planCode}` : ROUTES.onboardingSubscription;

  /** Client-side field validation, so the form reports problems without a round trip. */
  const validate = (): Record<string, string> => {
    const fieldErrors: Record<string, string> = {};
    if (!form.legalName.trim()) fieldErrors.legalName = 'Legal name is required.';
    if (!form.country) fieldErrors.country = 'Select a country.';
    if (!form.industry) fieldErrors.industry = 'Select an industry.';
    if (!form.baseCurrency) fieldErrors.baseCurrency = 'Select a base currency.';
    if (!form.fiscalYearStart) fieldErrors.fiscalYearStart = 'Select a financial-year start.';
    return fieldErrors;
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);

    const fieldErrors = validate();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      setFormError('Please fix the highlighted fields.');
      return;
    }

    // No backend in this build: the local store is the only place to put it.
    if (!isApiConfigured()) {
      const res = createOrganization(form);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error ?? 'Could not create organization.');
        return;
      }
      setErrors({});
      navigate(nextRoute());
      return;
    }

    setSubmitting(true);
    try {
      const created = await subscriptionApi.createOrganization({
        legalName: form.legalName.trim(),
        tradingName: form.tradingName.trim() || undefined,
        country: form.country,
        registrationNumber: form.registrationNumber.trim() || undefined,
        taxNumber: form.taxNumber.trim() || undefined,
        industry: form.industry,
        baseCurrency: form.baseCurrency,
        fiscalYearStart: form.fiscalYearStart,
        booksStartDate: form.booksStartDate || undefined,
      });

      // Adopt the record the API returned — its id, not a locally minted one.
      const adopted = created.organization
        ? adoptBackendOrganization(created.organization)
        : (await hydrateFromBackend({ force: true })).organizationId;

      if (!adopted) {
        setFormError('Your organization was created but could not be loaded. Please retry.');
        return;
      }
      setErrors({});
      // Only now — the store holds the backend-confirmed organization.
      navigate(nextRoute());
    } catch (error) {
      // 409 means this owner ALREADY has an organization. Creating a second one
      // would be the wrong repair; adopt the existing one and move on.
      if (error instanceof ApiError && error.status === 409) {
        const existing = await hydrateFromBackend({ force: true });
        if (existing.organizationId) {
          setErrors({});
          navigate(nextRoute());
          return;
        }
      }
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        setFormError(error.message || 'Could not create organization.');
        return;
      }
      setFormError('Could not create organization.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CenteredCard title="Set up your organization" subtitle="Tell us about the business you're keeping books for." width="xl">
      <Stepper current="Organization" />
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {formError && <Alert variant="error">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name" required error={errors.legalName}>
            <Input value={form.legalName} onChange={set('legalName')} placeholder="Acme Holdings Ltd." hasError={!!errors.legalName} />
          </Field>
          <Field label="Trading name" hint="Optional — if different from the legal name.">
            <Input value={form.tradingName} onChange={set('tradingName')} placeholder="Acme" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" required error={errors.country}>
            <Select options={COUNTRY_OPTIONS} value={form.country} onChange={set('country')} placeholder="Select country" hasError={!!errors.country} />
          </Field>
          <Field label="Industry" required error={errors.industry}>
            <Select options={industryOptions} value={form.industry} onChange={set('industry')} hasError={!!errors.industry} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Registration number" hint="Company / commercial registration.">
            <Input value={form.registrationNumber} onChange={set('registrationNumber')} placeholder="CR-000000" />
          </Field>
          <Field label="Tax number" hint="VAT / TRN, if registered.">
            <Input value={form.taxNumber} onChange={set('taxNumber')} placeholder="TRN-000000000" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Base currency" required error={errors.baseCurrency}>
            <Select options={currencyOptions} value={form.baseCurrency} onChange={set('baseCurrency')} hasError={!!errors.baseCurrency} />
          </Field>
          <Field label="Financial year start" required error={errors.fiscalYearStart}>
            <Select options={FY_START_OPTIONS} value={form.fiscalYearStart} onChange={set('fiscalYearStart')} hasError={!!errors.fiscalYearStart} />
          </Field>
          <Field label="Books start date" required>
            <Input type="date" value={form.booksStartDate} onChange={set('booksStartDate')} />
          </Field>
        </div>
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating your organization…' : 'Continue to subscription'}
          </Button>
        </div>
      </form>
    </CenteredCard>
  );
}
