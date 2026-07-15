import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Injects a page's primary actions into the global {@link PageHeader} action
 * slot (top-right of every page). Keeps page-level primary buttons visually
 * dominant and consistent without each page rebuilding its own header.
 */
export function PageActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);

  if (!target) return null;
  return createPortal(children, target);
}
