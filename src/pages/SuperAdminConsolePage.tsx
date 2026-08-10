/**
 * Platform Super-Administrator console.
 *
 * A single, clearly-separated place for Ledgora platform staff (NOT tenant
 * subscribers) to see applicants, subscribers and members, verify payments, edit
 * packages/pricing, and manage metering + infrastructure cost. Access is gated to
 * the platform administrator role; regular subscribers never see this view or its
 * sidebar entry.
 *
 * ── Capabilities ─────────────────────────────────────────────────────────────
 * The console asks the backend which capabilities the signed-in operator actually
 * holds (`GET /api/admin/me`) and passes them down so panels can avoid offering an
 * action that would come back 403. That list is a COURTESY, never authorization:
 * every route re-checks its own capability, so a browser that forges the list — or
 * a component that ignores it — gains nothing.
 *
 * ── Scope handoff between tabs ───────────────────────────────────────────────
 * "Members" on a subscriber row opens the Members tab filtered to that
 * organization. The scope lives here, in one piece of state, so switching
 * subscribers changes exactly one thing and the directory's own staleness guard
 * does the rest.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOrganizationStore } from '@/store/organizationStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useMemberDirectoryStore } from '@/store/memberDirectoryStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import { useIsPlatformAdmin, usePlatformAccess } from '@/hooks/usePlatformRole';
import { usePendingVerificationCount } from '@/store/billingHooks';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SubscribersPanel } from '@/components/admin/SubscribersPanel';
import { DisposableCleanupPanel } from '@/components/admin/DisposableCleanupPanel';
import { cleanupApi } from '@/services/api/cleanupApi';
import { ApplicantsPanel } from '@/components/admin/ApplicantsPanel';
import { MembersPanel } from '@/components/admin/MembersPanel';
import { CreateSubscriberDrawer } from '@/components/admin/CreateSubscriberDrawer';
import { AssignPackageDialog } from '@/components/admin/AssignPackageDialog';
import { CredentialResultDialog, type CredentialResult } from '@/components/admin/CredentialResultDialog';
import { isApiConfigured } from '@/services/api/client';
import {
  fetchAdminCapabilities,
  type CreateSubscriberResponse,
  type PlatformCapabilityName,
} from '@/services/api/adminConsoleApi';
import { useAdminSubscriberStore } from '@/store/adminConsoleStores';
import { PaymentVerificationPanel } from '@/components/billing/PaymentVerificationPanel';
import { PlanAdminEditor } from '@/components/billing/PlanAdminEditor';
import { BillingSettingsEditor } from '@/components/billing/BillingSettingsEditor';
import { InfrastructureCostDashboard } from '@/components/metering/InfrastructureCostDashboard';
import { MeteringConfigEditor } from '@/components/metering/MeteringConfigEditor';
import { UsageLedgerPanel } from '@/components/metering/UsageLedgerPanel';
import { EntitlementAdminPanel } from '@/components/admin/EntitlementAdminPanel';
import { Building2, ClipboardCheck, Package, Server, ShieldAlert, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';

type ConsoleTab = 'applicants' | 'subscribers' | 'members' | 'payments' | 'packages' | 'metering' | 'entitlements' | 'cleanup';

/**
 * What a build with no backend can do. The static demo has no account service, so
 * no capability is genuinely held — the browser-backed panels are read-mostly and
 * the create/assign actions are not offered at all.
 */
const NO_BACKEND_CAPABILITIES: PlatformCapabilityName[] = [];

export function SuperAdminConsolePage() {
  // Effective capability. In a production build this is always false, so the
  // console refuses to render regardless of what the browser has stored.
  // The console renders only when a role actually applies: confirmed by the
  // backend session in production, or simulated on a local dev server.
  const { verifiedByBackend, resolving } = usePlatformAccess();
  const isAdmin = useIsPlatformAdmin();
  const enterSubscriberView = useOperatorViewStore((s) => s.enter);
  const navigate = useRouterStore((s) => s.navigate);
  const pending = usePendingVerificationCount();
  const configured = isApiConfigured();

  /**
   * Land on Applicants when there is a backend to serve it — that roster is the
   * only one containing EVERY registered customer, including prospects who have
   * chosen no package. The static demo build has no such service, so it opens on
   * the browser-backed Subscribers view rather than an empty panel.
   */
  const [tab, setTab] = useState<ConsoleTab>(configured ? 'applicants' : 'subscribers');

  const [capabilities, setCapabilities] = useState<PlatformCapabilityName[]>(NO_BACKEND_CAPABILITIES);
  const [creating, setCreating] = useState(false);
  /**
   * The subscriber an operator named by pressing "Permanently delete" on its
   * row. It only pre-focuses the cleanup console; deletion still needs a fresh
   * preview, a reason and the typed phrase.
   */
  const [cleanupFocus, setCleanupFocus] = useState<string | undefined>(undefined);
  /**
   * Pending + failed object deletions across every operation, shown as a count
   * on the cleanup tab so leftover work from a crashed run is visible on arrival
   * rather than only to whoever thinks to look.
   */
  const [outstandingFiles, setOutstandingFiles] = useState(0);
  /**
   * The one-time credential, in PLAIN component state.
   *
   * Deliberately not a Zustand store and deliberately not persisted: a credential
   * that survived a reload would outlive the single response that is allowed to
   * contain it. Cleared the moment the dialog is dismissed.
   */
  const [credential, setCredential] = useState<CredentialResult | null>(null);
  /** Set when creation succeeded but no credential came back. */
  const [missingCredential, setMissingCredential] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [packageTarget, setPackageTarget] = useState<{ organizationId: string; name: string | null } | null>(null);
  /** The subscriber the Members tab is filtered to, if any. */
  const [memberScope, setMemberScope] = useState<{ organizationId: string; name: string } | null>(null);

  const reloadSubscribers = useAdminSubscriberStore((s) => s.load);

  // Ask the server what this operator may do. A failure leaves the list empty,
  // so the console degrades to read-only rather than offering actions blindly.
  useEffect(() => {
    if (!configured || !isAdmin) return;
    const controller = new AbortController();
    void fetchAdminCapabilities(controller.signal)
      .then((result) => setCapabilities(result.capabilities ?? []))
      .catch(() => setCapabilities(NO_BACKEND_CAPABILITIES));
    return () => controller.abort();
  }, [configured, isAdmin]);

  /*
   * Outstanding file cleanup, fetched once the operator is known to hold
   * `subscribers.delete` — the same capability the endpoint requires, so this
   * never fires a request that is going to 403. A failure leaves the count at
   * zero: an unknown number must not render as a false alarm.
   */
  useEffect(() => {
    if (!configured || !capabilities.includes('subscribers.delete')) return;
    let cancelled = false;
    void cleanupApi
      .fileStatus()
      .then((summary) => {
        if (!cancelled) setOutstandingFiles(summary.pending + summary.failed);
      })
      .catch(() => {
        if (!cancelled) setOutstandingFiles(0);
      });
    return () => {
      cancelled = true;
    };
  }, [configured, capabilities, tab]);

  // Leave the administration layout for the normal subscriber application,
  // WITHOUT touching the platform role. The operator stays a super-admin; only
  // an explicit, session-scoped viewing mode is set. An organization context is
  // attached when one is loaded so the dashboard has something to show.
  const exitToSubscriberView = (): void => {
    const org = useOrganizationStore.getState().organization;
    // Any roster from a previously viewed subscriber is discarded first.
    useMemberDirectoryStore.getState().clear();
    enterSubscriberView(
      org
        ? { organizationId: org.id, ownerUserId: org.ownerUserId, orgName: org.legalName }
        : undefined,
    );
    navigate(ROUTES.appDashboard);
  };

  const openMembersFor = useCallback((organizationId: string, name: string): void => {
    setMemberScope({ organizationId, name });
    setTab('members');
  }, []);

  /**
   * A subscriber was created. The ORDER here is the whole point.
   *
   *   1. capture the one-time credential into plain component state;
   *   2. open the dialog that shows it;
   *   3. only then refresh the roster;
   *   4. only then close the creation drawer.
   *
   * Refreshing or closing first is what loses an unrecoverable value: the drawer
   * unmounts mid-flight, or a re-render lands before the credential is committed
   * to state. The dialog is rendered as a SIBLING of the drawer (see the bottom of
   * this component), so closing the drawer cannot unmount it.
   *
   * If the response carried no credential the operator is told explicitly — the
   * account exists, so a silent "created successfully" would leave them with an
   * account nobody can sign in to and no idea why.
   */
  const handleSubscriberCreated = useCallback(
    (result: CreateSubscriberResponse, form: { fullName: string; email: string }): void => {
      const credentialResult = result.credential;

      // 1 & 2 — capture, then show. Nothing async in between.
      if (credentialResult) {
        setCredential({
          subjectName: form.fullName,
          subjectEmail: result.subscriber?.email ?? form.email,
          type: credentialResult.type,
          temporaryPassword: credentialResult.temporaryPassword,
          invitationToken: credentialResult.invitationToken,
          expiresAt: credentialResult.expiresAt,
          deliveryStatus: credentialResult.deliveryStatus,
          mustChangePassword: credentialResult.mustChangePassword,
          revokedSessions: credentialResult.revokedSessions,
          message: credentialResult.message,
        });
        setMissingCredential(null);
        setNotice(`${form.fullName} created as the owner of a new subscriber organization.`);
      } else {
        // Never report unqualified success when the credential is missing.
        setCredential(null);
        setMissingCredential(
          'Subscriber created, but no temporary credential was returned. Generate a new temporary password from the member details.',
        );
        setNotice(null);
      }

      // 3 — refresh, now that the credential is safely in state.
      setTab('subscribers');
      void reloadSubscribers({ limit: 25, offset: 0, sort: 'created_at', direction: 'desc' });

      // 4 — and only now close the drawer.
      setCreating(false);
    },
    [reloadSubscribers],
  );

  const tabs: TabItem<ConsoleTab>[] = useMemo(() => [
    { id: 'applicants', label: 'Applicants', icon: UserPlus },
    { id: 'subscribers', label: 'Subscribers', icon: Building2 },
    { id: 'members', label: 'Members', icon: Users },
    { id: 'payments', label: 'Payments', icon: ClipboardCheck, count: pending },
    { id: 'packages', label: 'Packages & pricing', icon: Package },
    { id: 'metering', label: 'Metering & infra cost', icon: Server },
    { id: 'entitlements', label: 'Entitlements', icon: ShieldCheck },
    /*
     * Only for an operator who actually holds `subscribers.delete`. The server
     * refuses everyone else regardless; hiding the tab keeps a support user from
     * walking into a wall of 403s.
     */
    ...(capabilities.includes('subscribers.delete')
      ? [
          {
            id: 'cleanup' as const,
            label: 'Clean up test/demo data',
            icon: Trash2,
            /*
             * Outstanding object deletions, counted at console level so they are
             * visible WITHOUT opening the tab. A file left behind by a crashed
             * run is only recoverable if somebody notices it, and nobody opens a
             * cleanup tab to check whether there is anything to notice.
             */
            count: outstandingFiles > 0 ? outstandingFiles : undefined,
          },
        ]
      : []),
  ], [pending, capabilities, outstandingFiles]);

  // Never paint the console while the server check is still in flight.
  if (resolving) return null;

  if (!isAdmin) {
    return (
      <Alert variant="error" title="Platform super-administrator only">
        This console is for Ledgora platform staff. Your subscriber account cannot access it.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {/* Be explicit about WHERE this authority came from. A simulated role is
          a local development convenience and grants nothing on a real server. */}
      {!verifiedByBackend && (
        <Alert variant="warning" title="Simulated administrator role (local development)">
          This role is not verified by the LEDGORA account service. Actions here affect only this browser —
          they are not real platform administration.
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-500/10">
        <span className="flex items-center gap-2 text-sm font-medium text-indigo-800 dark:text-indigo-200">
          <ShieldAlert className="h-4 w-4" /> You are acting as the Ledgora platform super-administrator.
        </span>
        <span className="flex items-center gap-3">
          {capabilities.includes('subscribers.create') && (
            <Button size="sm" onClick={() => setCreating(true)} data-testid="console-add-subscriber">
              <UserPlus className="h-3.5 w-3.5" aria-hidden /> Add subscriber
            </Button>
          )}
          {/*
            There is deliberately NO global "Add user" control here.
            ──────────────────────────────────────────────────────────────────
            A member belongs to exactly one subscriber, so "add a user" is only
            a meaningful act once you have said WHICH tenant — and a global
            button in the platform header invites an operator to answer that
            question with a dropdown, which is the wrong workflow. The
            subscriber's own Owner or Organization Admin adds their people from
            inside their workspace (Users & Roles), where the organization comes
            from their authenticated session and cannot be chosen at all.

            Operator support for a specific tenant has not been removed: it
            lives on the subscriber row as "Users & members", which is
            organization-targeted and clearly secondary to the customer's own
            workflow. See `BackendSubscribersPanel`.
          */}
          <button type="button" className="focus-ring rounded text-xs font-medium text-indigo-700 underline hover:no-underline dark:text-indigo-300" onClick={exitToSubscriberView}>
            Exit to subscriber view
          </button>
        </span>
      </div>

      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          <span data-testid="console-notice">{notice}</span>
        </Alert>
      )}

      {/*
        Creation succeeded but no credential arrived. Shown as a WARNING with the
        recovery step, never folded into the success banner — the account exists
        and nobody can sign in to it yet.
      */}
      {missingCredential && (
        <Alert
          variant="warning"
          title="Subscriber created without a credential"
          onClose={() => setMissingCredential(null)}
        >
          <span data-testid="console-missing-credential">{missingCredential}</span>
        </Alert>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'applicants' && <ApplicantsPanel />}

      {tab === 'cleanup' && <DisposableCleanupPanel focusOrganizationId={cleanupFocus} />}

      {tab === 'subscribers' && (
        <SubscribersPanel
          capabilities={capabilities}
          onAddSubscriber={() => setCreating(true)}
          onAssignPackage={(organizationId, name) => setPackageTarget({ organizationId, name })}
          onViewMembers={openMembersFor}
          /*
            A row action navigates to the cleanup console; it never deletes.
            The id travels with it so the operator lands on the tenant they
            named instead of having to find it again in the full roster —
            re-finding it by hand is how the wrong row gets ticked.
          */
          onCleanUp={(organizationId) => {
            setCleanupFocus(organizationId);
            setTab('cleanup');
          }}
        />
      )}

      {tab === 'members' && (
        <div className="space-y-3">
          {memberScope && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
              <span>
                Showing members of <b>{memberScope.name}</b>
              </span>
              <Button size="sm" variant="outline" onClick={() => setMemberScope(null)} data-testid="clear-member-scope">
                Show all members
              </Button>
            </div>
          )}
          <MembersPanel
            organizationId={memberScope?.organizationId ?? null}
            organizationName={memberScope?.name ?? null}
            capabilities={capabilities}
            onAssignPackage={(organizationId, name) => setPackageTarget({ organizationId, name })}
          />
        </div>
      )}

      {tab === 'payments' && <PaymentVerificationPanel />}

      {tab === 'packages' && (
        <div className="space-y-6">
          <Section title="Subscription packages & bank remittance">
            <PlanAdminEditor />
            <BillingSettingsEditor />
          </Section>
        </div>
      )}

      {tab === 'metering' && (
        <div className="space-y-6">
          <Section title="Infrastructure cost recovery"><InfrastructureCostDashboard /></Section>
          <Section title="Usage ledger"><UsageLedgerPanel /></Section>
          <Section title="Metering configuration"><MeteringConfigEditor /></Section>
        </div>
      )}

      {tab === 'entitlements' && (
        <Section title="Entitlements & subscription lifecycle"><EntitlementAdminPanel /></Section>
      )}

      <CreateSubscriberDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={handleSubscriberCreated}
      />


      <AssignPackageDialog
        open={packageTarget !== null}
        organizationId={packageTarget?.organizationId ?? null}
        organizationName={packageTarget?.name ?? null}
        onClose={() => setPackageTarget(null)}
        onAssigned={(result) => {
          setNotice(
            `Package changed to ${result.newPlanCode} for the whole organization (${result.direction}). Entitlements recalculated.`,
          );
          void reloadSubscribers({ limit: 25, offset: 0, sort: 'created_at', direction: 'desc' });
        }}
      />

      {/*
        A SIBLING of the creation drawer, never a child of it — so closing the
        drawer cannot unmount the dialog carrying the credential. Dismissing it
        drops the value from state immediately and irrecoverably.
      */}
      <CredentialResultDialog result={credential} onClose={() => setCredential(null)} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2"><Badge tone="indigo">Super admin</Badge><h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3></div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
