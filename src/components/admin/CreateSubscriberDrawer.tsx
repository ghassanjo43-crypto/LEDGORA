/**
 * "Add subscriber" — the manual creation form.
 *
 * ── What it creates ─────────────────────────────────────────────────────────
 * One request, one transaction: the user, the organization, the owner membership,
 * the subscription application, the selected package, the subscription, the
 * entitlement record and the audit entries. The form cannot produce a partial
 * subscriber because it does not create the pieces separately — see
 * `server/src/services/subscriberService.ts`.
 *
 * ── The two onboarding routes ────────────────────────────────────────────────
 * `invite`    a single-use expiring link. Chosen by default, because handing over
 *             a password is a worse habit than sending a link — and the server
 *             reports honestly whether delivery actually happened.
 * `temporary` a generated password, shown once, hashed immediately, forced to be
 *             changed at first sign-in.
 * Either way the customer ends up choosing their own password, and this component
 * never sees or stores a credential beyond passing the response to the result
 * dialog.
 */
import { useEffect, useMemo, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import { COUNTRY_OPTIONS } from '@/lib/onboardingData';
import { subscriptionApi, type PublicPlan } from '@/services/api/authApi';
import { adminSubscriberApi, type CreateSubscriberResponse } from '@/services/api/adminConsoleApi';
import { ApiError } from '@/services/api/client';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active — entitled immediately' },
  { value: 'pending_payment', label: 'Pending payment — awaiting transfer' },
  { value: 'pending_verification', label: 'Pending verification — proof under review' },
  { value: 'draft', label: 'Draft — package chosen, nothing issued' },
  { value: 'suspended', label: 'Suspended' },
];

const BILLING_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
];

const ONBOARDING_OPTIONS = [
  { value: 'invite', label: 'Send an invitation / reset link' },
  { value: 'temporary', label: 'Generate a one-time temporary password' },
];

interface FormState {
  fullName: string;
  email: string;
  organizationLegalName: string;
  tradingName: string;
  country: string;
  baseCurrency: string;
  planId: string;
  modules: string[];
  subscriptionStatus: string;
  startDate: string;
  billingCycle: 'monthly' | 'annual';
  seatAllowance: string;
  entityAllowance: string;
  storageAllowance: string;
  paymentConfirmed: boolean;
  internalNotes: string;
  onboarding: 'invite' | 'temporary';
}

const today = (): string => new Date().toISOString().slice(0, 10);

const EMPTY: FormState = {
  fullName: '',
  email: '',
  organizationLegalName: '',
  tradingName: '',
  country: 'AE',
  baseCurrency: 'USD',
  planId: '',
  modules: [],
  subscriptionStatus: 'pending_payment',
  startDate: today(),
  billingCycle: 'monthly',
  seatAllowance: '',
  entityAllowance: '',
  storageAllowance: '',
  paymentConfirmed: false,
  internalNotes: '',
  onboarding: 'invite',
};

/** Optional modules the operator may add on top of a package. */
const OPTIONAL_MODULES = [
  'inventory_basic',
  'inventory_advanced',
  'cost_centers',
  'multi_currency',
  'projects',
  'multi_entity',
  'manufacturing',
  'construction',
  'fixed_assets',
];

export interface CreateSubscriberDrawerProps {
  open: boolean;
  /**
   * Cancel. NOT called on success — the parent closes the drawer itself, after it
   * has captured the credential. See `onCreated`.
   */
  onClose: () => void;
  /**
   * The complete creation response, handed over BEFORE this drawer closes or
   * resets anything.
   *
   * The parent owns the ordering from here on (capture → open dialog → refresh →
   * close), because a drawer that closed itself on success would unmount mid-way
   * through and could drop the one-time credential it was carrying.
   */
  onCreated: (result: CreateSubscriberResponse, form: { fullName: string; email: string }) => void;
}

export function CreateSubscriberDrawer({ open, onClose, onCreated }: CreateSubscriberDrawerProps) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingPlans, setLoadingPlans] = useState(false);

  // A fresh form each time it opens: a half-typed subscriber from a cancelled
  // attempt must not be submitted as part of the next one.
  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setFieldErrors({});
    setError(null);

    let cancelled = false;
    setLoadingPlans(true);
    void subscriptionApi
      .listPublicPlans()
      .then((result) => {
        if (cancelled) return;
        setPlans(result.plans);
        // Preselect the first package so "base package" is never silently empty.
        setForm((current) => ({ ...current, planId: current.planId || (result.plans[0]?.id ?? '') }));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Could not load the package catalogue.');
      })
      .finally(() => {
        if (!cancelled) setLoadingPlans(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selectedPlan = useMemo(() => plans.find((p) => p.id === form.planId), [plans, form.planId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  };

  const toggleModule = (module: string): void => {
    setForm((current) => ({
      ...current,
      modules: current.modules.includes(module)
        ? current.modules.filter((m) => m !== module)
        : [...current.modules, module],
    }));
  };

  /**
   * Confirming payment implies an entitled subscription — keep the two in step so
   * an operator cannot tick "already paid" and leave the customer locked out.
   */
  const setPaymentConfirmed = (value: boolean): void => {
    setForm((current) => ({
      ...current,
      paymentConfirmed: value,
      subscriptionStatus: value
        ? 'active'
        : current.subscriptionStatus === 'active'
          ? 'pending_payment'
          : current.subscriptionStatus,
    }));
  };

  const submit = async (): Promise<void> => {
    // Local validation first, so the obvious omissions are caught without a round
    // trip. The server validates everything again regardless.
    const problems: Record<string, string> = {};
    if (!form.fullName.trim()) problems.fullName = 'Full name is required.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) problems.email = 'Enter a valid email address.';
    if (!form.organizationLegalName.trim()) problems.organizationLegalName = 'Organization legal name is required.';
    if (!form.country) problems.country = 'Country is required.';
    if (!form.planId) problems.planId = 'Choose a base package.';
    if (Object.keys(problems).length > 0) {
      setFieldErrors(problems);
      setError('Please fix the highlighted fields.');
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await adminSubscriberApi.create({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        organizationLegalName: form.organizationLegalName.trim(),
        ...(form.tradingName.trim() ? { tradingName: form.tradingName.trim() } : {}),
        country: form.country,
        baseCurrency: form.baseCurrency,
        planId: form.planId,
        ...(form.modules.length > 0 ? { modules: form.modules } : {}),
        subscriptionStatus: form.subscriptionStatus,
        startDate: form.startDate,
        billingCycle: form.billingCycle,
        ...(form.seatAllowance ? { seatAllowance: Number(form.seatAllowance) } : {}),
        ...(form.entityAllowance ? { entityAllowance: Number(form.entityAllowance) } : {}),
        ...(form.storageAllowance ? { storageAllowance: Number(form.storageAllowance) } : {}),
        paymentConfirmed: form.paymentConfirmed,
        ...(form.internalNotes.trim() ? { internalNotes: form.internalNotes.trim() } : {}),
        onboarding: form.onboarding,
      });
      /*
       * Hand the WHOLE response over before doing anything else. No close, no
       * form reset, no roster refresh happens on this side of the call — the
       * parent performs them in an order that cannot lose the credential, and
       * closes this drawer last.
       */
      onCreated(result, { fullName: form.fullName.trim(), email: form.email.trim() });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setFieldErrors(cause.fieldErrors);
        setError(cause.message);
      } else {
        setError('Could not create the subscriber.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      widthClassName="max-w-2xl"
      title="Add subscriber"
      description="Creates the account, the organization, the owner membership and the subscription in one transaction."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || loadingPlans} data-testid="create-subscriber-submit">
            {busy ? 'Creating…' : 'Create subscriber'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert variant="error">{error}</Alert>}

        <Alert variant="info">
          The subscriber is the ORGANIZATION. The person named below becomes its owner — a member with the owner role,
          not a separate kind of account.
        </Alert>

        {/* ── Owner ──────────────────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owner</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required error={fieldErrors.fullName}>
              <Input
                value={form.fullName}
                onChange={(event) => set('fullName', event.target.value)}
                placeholder="Nadia Owner"
                hasError={!!fieldErrors.fullName}
              />
            </Field>
            <Field label="Email" required error={fieldErrors.email}>
              <Input
                type="email"
                value={form.email}
                onChange={(event) => set('email', event.target.value)}
                placeholder="nadia@company.com"
                hasError={!!fieldErrors.email}
              />
            </Field>
          </div>
        </fieldset>

        {/* ── Organization ───────────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Organization</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Legal name" required error={fieldErrors.organizationLegalName}>
              <Input
                value={form.organizationLegalName}
                onChange={(event) => set('organizationLegalName', event.target.value)}
                placeholder="NewCo Trading LLC"
                hasError={!!fieldErrors.organizationLegalName}
              />
            </Field>
            <Field label="Trading name">
              <Input value={form.tradingName} onChange={(event) => set('tradingName', event.target.value)} />
            </Field>
            <Field label="Country" required error={fieldErrors.country}>
              <Select
                options={COUNTRY_OPTIONS}
                value={form.country}
                onChange={(event) => set('country', event.target.value)}
                hasError={!!fieldErrors.country}
                aria-label="Country"
              />
            </Field>
            <Field label="Base currency">
              <Input
                value={form.baseCurrency}
                onChange={(event) => set('baseCurrency', event.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
              />
            </Field>
          </div>
        </fieldset>

        {/* ── Package ────────────────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Package</legend>
          <Field label="Base package" required error={fieldErrors.planId} hint={loadingPlans ? 'Loading the catalogue…' : undefined}>
            <Select
              options={plans.map((plan) => ({
                value: plan.id,
                label: `${plan.name} — ${plan.currency} ${plan.monthlyPrice}/mo · ${plan.userLimit} users`,
              }))}
              value={form.planId}
              onChange={(event) => set('planId', event.target.value)}
              hasError={!!fieldErrors.planId}
              aria-label="Base package"
            />
          </Field>

          {selectedPlan && (
            <p className="flex flex-wrap gap-1 text-xs text-slate-500">
              Included:
              {selectedPlan.modules.map((module) => (
                <Badge key={module} tone="teal">
                  {module}
                </Badge>
              ))}
            </p>
          )}

          <Field label="Optional modules" hint="Added on top of the base package for this tenant only.">
            <div className="flex flex-wrap gap-1.5">
              {OPTIONAL_MODULES.filter((module) => !selectedPlan?.modules.includes(module)).map((module) => {
                const on = form.modules.includes(module);
                return (
                  <button
                    key={module}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleModule(module)}
                    className={
                      on
                        ? 'focus-ring rounded-md border border-teal-300 bg-teal-50 px-2 py-1 text-xs font-medium text-teal-800 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-200'
                        : 'focus-ring rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300'
                    }
                  >
                    {module}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Billing period">
              <Select
                options={BILLING_OPTIONS}
                value={form.billingCycle}
                onChange={(event) => set('billingCycle', event.target.value as 'monthly' | 'annual')}
                aria-label="Billing period"
              />
            </Field>
            <Field label="Start date">
              <Input type="date" value={form.startDate} onChange={(event) => set('startDate', event.target.value)} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Seat allowance" hint={`Plan default: ${selectedPlan?.userLimit ?? '—'}`}>
              <Input
                type="number"
                min={1}
                value={form.seatAllowance}
                onChange={(event) => set('seatAllowance', event.target.value)}
                placeholder="Inherit"
              />
            </Field>
            <Field label="Entity allowance" hint={`Plan default: ${selectedPlan?.entityLimit ?? '—'}`}>
              <Input
                type="number"
                min={1}
                value={form.entityAllowance}
                onChange={(event) => set('entityAllowance', event.target.value)}
                placeholder="Inherit"
              />
            </Field>
            <Field label="Storage override (bytes)">
              <Input
                type="number"
                min={0}
                value={form.storageAllowance}
                onChange={(event) => set('storageAllowance', event.target.value)}
                placeholder="Inherit"
              />
            </Field>
          </div>
        </fieldset>

        {/* ── Status ─────────────────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</legend>
          <div className="flex items-start gap-3">
            <Toggle
              checked={form.paymentConfirmed}
              onChange={setPaymentConfirmed}
              label="Payment is already confirmed"
              id="payment-confirmed"
            />
            <label htmlFor="payment-confirmed" className="text-sm">
              <span className="font-medium text-slate-800 dark:text-slate-100">Payment is already confirmed</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Activates the subscription immediately, bypassing the payment workflow. Recorded in the audit trail.
              </span>
            </label>
          </div>
          <Field label="Subscription status">
            <Select
              options={STATUS_OPTIONS}
              value={form.subscriptionStatus}
              onChange={(event) => set('subscriptionStatus', event.target.value)}
              aria-label="Subscription status"
            />
          </Field>
        </fieldset>

        {/* ── Onboarding ─────────────────────────────────────────────────── */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Onboarding</legend>
          <Field
            label="How does the owner get in?"
            hint="Either way they must choose their own password before they can use the account."
          >
            <Select
              options={ONBOARDING_OPTIONS}
              value={form.onboarding}
              onChange={(event) => set('onboarding', event.target.value as 'invite' | 'temporary')}
              aria-label="Onboarding method"
            />
          </Field>
          {form.onboarding === 'temporary' ? (
            <Alert variant="warning" title="Shown once">
              The generated password appears once, immediately after creation. Only its Argon2id hash is stored, so it
              cannot be retrieved afterwards — pass it on through a channel you trust.
            </Alert>
          ) : (
            <Alert variant="info" title="Delivery is reported honestly">
              A single-use expiring link is created. If email delivery is not configured, Ledgora says so and gives you
              the link to pass on yourself — it never claims to have sent a message it did not send.
            </Alert>
          )}
        </fieldset>

        <Field label="Internal notes" hint="Visible to platform staff only. Never shown to the customer.">
          <Textarea
            value={form.internalNotes}
            onChange={(event) => set('internalNotes', event.target.value)}
            placeholder="How this account came about, agreed terms, who to contact…"
          />
        </Field>
      </div>
    </Drawer>
  );
}
