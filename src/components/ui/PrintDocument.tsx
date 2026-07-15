import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders a print-only copy of a document at the <body> level (outside #root).
 * On screen it is hidden; in print it becomes the ONLY visible content — the app
 * shell (#root: navigation, filters, the credit-note list, the modal chrome) is
 * hidden via the `html.has-print-document` rule in index.css.
 *
 * This guarantees the printed PDF contains just the A4 document — no list above
 * it and no spurious blank second page. The hiding is opt-in (scoped to when a
 * PrintDocument is mounted) so other print flows are never affected.
 */
export function PrintDocument({ children }: { children: ReactNode }) {
  const [el] = useState(() => {
    const d = document.createElement('div');
    d.className = 'print-document';
    return d;
  });

  useEffect(() => {
    document.body.appendChild(el);
    const root = document.documentElement;
    root.classList.add('has-print-document');
    return () => {
      root.classList.remove('has-print-document');
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  }, [el]);

  return createPortal(children, el);
}
