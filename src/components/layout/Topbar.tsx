import { useMemo, useState } from 'react';
import {
  Menu as MenuIcon,
  Search,
  Bell,
  Sun,
  Moon,
  Settings,
  ChevronDown,
  CalendarDays,
  Check,
  AlertTriangle,
  LogOut,
  UserCog,
  ChevronsUpDown,
  Plus,
  Trash2,
} from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useCompanyStore } from '@/store/companyStore';
import { useAuthStore } from '@/store/authStore';
import { useSessionStore } from '@/store/sessionStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { validateChart } from '@/lib/validation';
import { computeJournalStats } from '@/lib/journalSelectors';
import { Avatar } from '@/components/ui/Avatar';
import { Dropdown, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Dropdown';
import { AddCompanyDialog } from '@/components/company/AddCompanyDialog';
import { EditionBadge } from '@/components/entitlements/EditionBadge';
import { DevelopmentEditionSwitcher } from '@/components/entitlements/DevelopmentEditionSwitcher';
import { platformAdminToolsAllowed } from '@/lib/platformAccess';
import { useIsPlatformAdmin } from '@/hooks/usePlatformRole';
import { authService } from '@/services';
import { cn } from '@/lib/utils';
import { CreditCard } from 'lucide-react';

const USER = { name: 'Finance Manager', role: 'Administrator' };

export function Topbar({
  onOpenSearch,
  onOpenMobileNav,
}: {
  onOpenSearch: () => void;
  onOpenMobileNav: () => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useJournalStore((s) => s.entries);
  const { theme, toggleTheme } = useTheme();

  const { errorCount, warningCount, unbalancedDrafts } = useMemo(() => {
    const issues = validateChart(accounts);
    const stats = computeJournalStats(entries);
    return {
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
      unbalancedDrafts: stats.unbalancedDrafts,
    };
  }, [accounts, entries]);

  const alertTotal = errorCount + unbalancedDrafts;

  const period = useMemo(() => {
    const now = new Date();
    return now.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }, []);

  // Signed-in user (for the account menu + sign-out).
  const users = useAuthStore((s) => s.users);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useRouterStore((s) => s.navigate);
  const currentUser = useMemo(
    () => users.find((u) => u.id === currentUserId) ?? null,
    [users, currentUserId],
  );
  const userName = currentUser?.fullName ?? USER.name;
  const userSubtitle = currentUser?.email ?? USER.role;
  // Effective capability: always false in a production build, whatever is
  // stored in the browser.
  const isPlatformAdmin = useIsPlatformAdmin();
  const setPlatformRole = useSessionStore((s) => s.setPlatformRole);
  const signOut = (): void => {
    // Clears the authenticated session AND every temporary demo record, then
    // returns to the public welcome page. Durable records of other accounts are
    // untouched (see services/devAuthService.signOut).
    void authService.signOut().then(() => navigate(ROUTES.welcome, { replace: true }));
  };
  void logout; // sign-out goes through the AuthService, not the store directly

  const companies = useCompanyStore((s) => s.companies);
  const activeCompanyId = useCompanyStore((s) => s.activeCompanyId);
  const switchCompany = useCompanyStore((s) => s.switchCompany);
  const deleteCompany = useCompanyStore((s) => s.deleteCompany);

  const [companyQuery, setCompanyQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const companyList = companies
    .map((c) => ({ id: c.id, name: c.id === activeCompanyId ? settings.companyName : c.settings.companyName }))
    .filter((c) => c.name.toLowerCase().includes(companyQuery.trim().toLowerCase()));

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/85 px-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85 sm:px-4">
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
        aria-label="Open navigation"
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      {/* Company selector */}
      <Dropdown
        align="left"
        label="Switch company"
        closeOnClick={false}
        panelClassName="w-72"
        trigger={(o) => (
          <span
            className={cn(
              'flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
              o && 'bg-slate-50 dark:bg-slate-800',
            )}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-600 text-[11px] font-bold text-white">
              {settings.companyName.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden max-w-[160px] truncate font-medium text-slate-700 dark:text-slate-200 sm:block">
              {settings.companyName}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-slate-400" />
          </span>
        )}
      >
        <div className="relative mb-1 px-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={companyQuery}
            onChange={(e) => setCompanyQuery(e.target.value)}
            placeholder="Search companies…"
            className="focus-ring w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        <MenuLabel>Companies ({companies.length})</MenuLabel>
        <div className="max-h-64 overflow-y-auto">
          {companyList.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-slate-400">No matches.</p>
          ) : (
            companyList.map((c) => {
              const active = c.id === activeCompanyId;
              return (
                <div key={c.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => switchCompany(c.id)}
                    className={cn(
                      'focus-ring flex flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      active ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-200' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                    )}
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-brand-600 text-[10px] font-bold text-white">
                      {c.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="flex-1 truncate">{c.name}</span>
                    {active && <Check className="h-4 w-4 shrink-0 text-brand-500" />}
                  </button>
                  {!active && companies.length > 1 && (
                    <button
                      type="button"
                      onClick={() => deleteCompany(c.id)}
                      title="Delete company"
                      className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
        <MenuSeparator />
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
        >
          <Plus className="h-4 w-4" /> Add company
        </button>
      </Dropdown>

      <AddCompanyDialog open={addOpen} onClose={() => setAddOpen(false)} />

      {/* Global search */}
      <button
        type="button"
        onClick={onOpenSearch}
        className="focus-ring group ml-1 hidden h-9 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 text-sm text-slate-400 transition-colors hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-800/40 dark:hover:bg-slate-800 md:flex md:max-w-md"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Search everything…</span>
        <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-400 dark:border-slate-600 dark:bg-slate-900">
          Ctrl K
        </kbd>
      </button>

      <div className="flex-1 md:hidden" />

      {/* Development-only edition switcher (hidden in production) */}
      <div className="hidden xl:block">
        <DevelopmentEditionSwitcher compact />
      </div>

      {/* Edition badge → subscription */}
      <button
        type="button"
        onClick={() => setActiveView('subscription')}
        className="focus-ring hidden lg:inline-flex"
        title="Manage subscription"
      >
        <EditionBadge />
      </button>

      {/* Search (mobile icon) */}
      <button
        type="button"
        onClick={onOpenSearch}
        className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
        aria-label="Search"
      >
        <Search className="h-5 w-5" />
      </button>

      {/* Accounting period */}
      <div className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300 lg:flex">
        <CalendarDays className="h-4 w-4 text-slate-400" />
        {period}
        <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
          Open
        </span>
      </div>

      {/* Notifications */}
      <Dropdown
        label="Notifications"
        panelClassName="w-80"
        trigger={() => (
          <span className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
            <Bell className="h-5 w-5" />
            {alertTotal > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                {alertTotal}
              </span>
            )}
          </span>
        )}
      >
        <MenuLabel>Notifications</MenuLabel>
        {alertTotal === 0 && warningCount === 0 ? (
          <div className="flex items-center gap-2 px-2.5 py-3 text-sm text-slate-500">
            <Check className="h-4 w-4 text-emerald-500" /> Everything looks healthy.
          </div>
        ) : (
          <>
            {errorCount > 0 && (
              <MenuItem icon={AlertTriangle} onClick={() => setActiveView('dashboard')}>
                {errorCount} chart validation error{errorCount === 1 ? '' : 's'}
              </MenuItem>
            )}
            {unbalancedDrafts > 0 && (
              <MenuItem icon={AlertTriangle} onClick={() => setActiveView('journal')}>
                {unbalancedDrafts} unbalanced draft{unbalancedDrafts === 1 ? '' : 's'}
              </MenuItem>
            )}
            {warningCount > 0 && (
              <MenuItem icon={AlertTriangle} onClick={() => setActiveView('dashboard')}>
                {warningCount} chart warning{warningCount === 1 ? '' : 's'}
              </MenuItem>
            )}
          </>
        )}
      </Dropdown>

      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>

      {/* Settings shortcut */}
      <button
        type="button"
        onClick={() => setActiveView('settings')}
        className="focus-ring hidden h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 sm:flex"
        aria-label="Settings"
        title="Settings"
      >
        <Settings className="h-5 w-5" />
      </button>

      {/* User menu */}
      <Dropdown
        label="Account menu"
        trigger={() => (
          <span className="flex items-center gap-1.5 rounded-lg py-0.5 pl-0.5 pr-1 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
            <Avatar name={userName} size="sm" />
            <ChevronDown className="hidden h-3.5 w-3.5 text-slate-400 sm:block" />
          </span>
        )}
      >
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <Avatar name={userName} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{userName}</p>
            <p className="truncate text-xs text-slate-400">{userSubtitle}</p>
          </div>
        </div>
        <MenuSeparator />
        <MenuItem icon={UserCog} onClick={() => setActiveView('settings')}>Preferences</MenuItem>
        <MenuItem icon={Settings} onClick={() => setActiveView('settings')}>Company settings</MenuItem>
        <MenuItem icon={CreditCard} onClick={() => setActiveView('subscription')}>Subscription</MenuItem>
        <MenuSeparator />
        {/* Platform super-admin entry points. The "enter" switch is a
            development tool and is never offered to ordinary customers. */}
        {isPlatformAdmin ? (
          <>
            <MenuItem icon={ShieldCheck} onClick={() => setActiveView('super-admin')}>Super Admin console</MenuItem>
            <MenuItem icon={ShieldOff} onClick={() => setPlatformRole('none')}>Exit super-admin mode</MenuItem>
            <MenuSeparator />
          </>
        ) : platformAdminToolsAllowed() ? (
          <>
            <MenuItem icon={ShieldCheck} onClick={() => setPlatformRole('super-admin')}>Enter super-admin mode (local development only)</MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem icon={LogOut} onClick={signOut}>Sign out</MenuItem>
      </Dropdown>
    </header>
  );
}
