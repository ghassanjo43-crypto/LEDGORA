/**
 * Customer registration.
 *
 * Collects full name, business email, password + confirmation, optional company
 * name, country and terms acceptance, then hands the values to the `AuthService`
 * (see `services/devAuthService.ts` for the development adapter and the exact
 * backend seam). The raw password lives in component state for the duration of
 * the submit and is never written to a store or to browser storage.
 *
 * On success the new user is `registered-no-plan` and goes straight to package
 * selection.
 */
import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { COUNTRY_OPTIONS } from '@/lib/onboardingData';
import { ROUTES } from '@/lib/accessControl';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { authService } from '@/services';

const EMPTY = {
  fullName: '',
  email: '',
  password: '',
  confirmPassword: '',
  companyName: '',
  country: '',
  mobile: '',
};

export function RegisterPage() {
  const navigate = useRouterStore((s) => s.navigate);
  const planCode = useRouterStore((s) => s.query.plan);

  const [form, setForm] = useState({ ...EMPTY });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success'>('idle');

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    setStatus('submitting');

    const result = await authService.register({
      fullName: form.fullName,
      email: form.email,
      password: form.password,
      confirmPassword: form.confirmPassword,
      companyName: form.companyName || undefined,
      country: form.country,
      mobile: form.mobile,
      acceptedTerms,
      intendedPlanCode: planCode,
    });

    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      setFormError(result.error ?? 'Registration failed.');
      setStatus('idle');
      return;
    }

    setErrors({});
    setStatus('success');
    // Registered with no plan → choose a package (or the free demo) next.
    navigate(ROUTES.onboardingSubscription);
  };

  const busy = status === 'submitting';

  return (
    <CenteredCard
      title="Create your LEDGORA account"
      subtitle={planCode ? `You're signing up for the ${planCode} plan.` : 'Start your 5-minute setup.'}
      footer={
        <span>
          Already have an account?{' '}
          <button
            type="button"
            className="focus-ring rounded font-medium text-brand-600 hover:underline"
            onClick={() => navigate(ROUTES.login)}
          >
            Sign in
          </button>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {formError && <Alert variant="error">{formError}</Alert>}
        {status === 'success' && (
          <Alert variant="success">Account created. Taking you to package selection…</Alert>
        )}

        <Field label="Full name" htmlFor="reg-full-name" required error={errors.fullName}>
          <Input
            id="reg-full-name"
            name="fullName"
            autoComplete="name"
            value={form.fullName}
            onChange={set('fullName')}
            placeholder="Jane Doe"
            hasError={!!errors.fullName}
          />
        </Field>

        <Field label="Business email" htmlFor="reg-email" required error={errors.email}>
          <Input
            id="reg-email"
            name="email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={set('email')}
            placeholder="you@company.com"
            hasError={!!errors.email}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="reg-password"
          required
          error={errors.password}
          hint="At least 8 characters, with a letter and a number."
        >
          <div className="relative">
            <Input
              id="reg-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              placeholder="••••••••"
              hasError={!!errors.password}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="focus-ring absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        <Field label="Confirm password" htmlFor="reg-confirm-password" required error={errors.confirmPassword}>
          <Input
            id="reg-confirm-password"
            name="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={set('confirmPassword')}
            placeholder="••••••••"
            hasError={!!errors.confirmPassword}
          />
        </Field>

        <Field label="Company name" htmlFor="reg-company" error={errors.companyName} hint="Optional — you can add it later.">
          <Input
            id="reg-company"
            name="companyName"
            autoComplete="organization"
            value={form.companyName}
            onChange={set('companyName')}
            placeholder="Acme Holdings Ltd."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" htmlFor="reg-country" required error={errors.country}>
            <Select
              id="reg-country"
              name="country"
              options={COUNTRY_OPTIONS}
              value={form.country}
              onChange={set('country')}
              placeholder="Select country"
              hasError={!!errors.country}
            />
          </Field>
          <Field label="Mobile number" htmlFor="reg-mobile" error={errors.mobile} hint="Optional.">
            <Input
              id="reg-mobile"
              name="mobile"
              autoComplete="tel"
              value={form.mobile}
              onChange={set('mobile')}
              placeholder="+971 50 000 0000"
              hasError={!!errors.mobile}
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            id="reg-terms"
            type="checkbox"
            className="focus-ring mt-0.5"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
          />
          <span>
            I agree to the LEDGORA Terms of Service and Privacy Policy.
            {errors.acceptedTerms && <span className="block text-red-600">{errors.acceptedTerms}</span>}
          </span>
        </label>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </CenteredCard>
  );
}
