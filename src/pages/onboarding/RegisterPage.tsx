/**
 * Customer registration. Collects full name, business email, mobile, country,
 * password and terms acceptance. Reads the intended plan from ?plan=. On success
 * the account is created (unverified) and the user is sent to /verify-email.
 */
import { useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { COUNTRY_OPTIONS } from '@/lib/onboardingData';
import { ROUTES } from '@/lib/accessControl';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

export function RegisterPage() {
  const register = useAuthStore((s) => s.register);
  const navigate = useRouterStore((s) => s.navigate);
  const planCode = useRouterStore((s) => s.query.plan);

  const [form, setForm] = useState({ fullName: '', email: '', mobile: '', country: '', password: '' });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setFormError(null);
    const res = register({ ...form, acceptedTerms, intendedPlanCode: planCode });
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      setFormError(res.error ?? 'Registration failed.');
      return;
    }
    setErrors({});
    navigate(ROUTES.verifyEmail);
  };

  return (
    <CenteredCard
      title="Create your Ledgora account"
      subtitle={planCode ? `You're signing up for the ${planCode} plan.` : 'Start your 5-minute setup.'}
      footer={
        <span>
          Already have an account?{' '}
          <button className="font-medium text-brand-600 hover:underline" onClick={() => navigate(ROUTES.login)}>
            Sign in
          </button>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        {formError && <Alert variant="error">{formError}</Alert>}
        <Field label="Full name" required error={errors.fullName}>
          <Input value={form.fullName} onChange={set('fullName')} placeholder="Jane Doe" hasError={!!errors.fullName} />
        </Field>
        <Field label="Business email" required error={errors.email}>
          <Input type="email" value={form.email} onChange={set('email')} placeholder="you@company.com" hasError={!!errors.email} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mobile number" required error={errors.mobile}>
            <Input value={form.mobile} onChange={set('mobile')} placeholder="+971 50 000 0000" hasError={!!errors.mobile} />
          </Field>
          <Field label="Country" required error={errors.country}>
            <Select
              options={COUNTRY_OPTIONS}
              value={form.country}
              onChange={set('country')}
              placeholder="Select country"
              hasError={!!errors.country}
            />
          </Field>
        </div>
        <Field label="Password" required error={errors.password} hint="At least 8 characters, with a letter and a number.">
          <Input type="password" value={form.password} onChange={set('password')} placeholder="••••••••" hasError={!!errors.password} />
        </Field>
        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
          />
          <span>
            I agree to the Ledgora Terms of Service and Privacy Policy.
            {errors.acceptedTerms && <span className="block text-red-600">{errors.acceptedTerms}</span>}
          </span>
        </label>
        <Button type="submit" className="w-full">
          Create account
        </Button>
      </form>
    </CenteredCard>
  );
}
