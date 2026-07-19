/**
 * Free Demo confirmation. Shown before a demo workspace starts so the visitor
 * is told, in plain words, that the information is temporary.
 */
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { FREE_DEMO_COPY } from '@/config/freeDemo';
import { subscriptionService } from '@/services';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';

export interface FreeDemoConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  /** What "Choose a package" does from this surface. */
  onChoosePackage: () => void;
  choosePackageLabel?: string;
  /** Called after the demo workspace has started (defaults to opening the app). */
  onEntered?: () => void;
}

export function FreeDemoConfirmDialog({
  open,
  onCancel,
  onChoosePackage,
  choosePackageLabel = FREE_DEMO_COPY.confirmChoosePackage,
  onEntered,
}: FreeDemoConfirmDialogProps) {
  const enterRef = useRef<HTMLButtonElement>(null);
  const navigate = useRouterStore((s) => s.navigate);

  useEffect(() => {
    if (!open) return;
    enterRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const enterDemo = async (): Promise<void> => {
    await subscriptionService.startFreeDemo();
    if (onEntered) onEntered();
    else navigate(ROUTES.appDashboard);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="free-demo-dialog-title"
      aria-describedby="free-demo-dialog-body"
    >
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <h2 id="free-demo-dialog-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {FREE_DEMO_COPY.confirmTitle}
        </h2>
        <p id="free-demo-dialog-body" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {FREE_DEMO_COPY.confirmBody}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onChoosePackage}>
            {choosePackageLabel}
          </Button>
          <Button ref={enterRef} onClick={() => void enterDemo()}>
            {FREE_DEMO_COPY.confirmEnter}
          </Button>
        </div>
      </div>
    </div>
  );
}
