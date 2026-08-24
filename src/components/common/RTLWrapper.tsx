/**
 * Direction scoping.
 *
 * ══ What this is actually for ════════════════════════════════════════════════
 *
 * NOT for turning the app right-to-left. `LanguageProvider` sets `dir` on
 * `<html>`, which is the only place that makes the browser's bidirectional
 * algorithm, form-control alignment and scrollbar placement all agree. A
 * wrapper `<div dir="rtl">` gets most of that and misses the rest.
 *
 * This exists for the opposite problem: the things inside an Arabic page that
 * must NOT be reordered.
 *
 * ══ The bug it prevents ══════════════════════════════════════════════════════
 *
 * Unicode bidi reorders "neutral" characters — hyphens, slashes, brackets,
 * colons — according to the surrounding text direction. Inside an RTL
 * paragraph, the invoice number
 *
 *     INV-2026-0001
 *
 * is a run of Latin letters and digits joined by neutral hyphens, and the
 * algorithm is entitled to render it as
 *
 *     0001-2026-INV
 *
 * The characters are unchanged; only their visual order is. A user reads the
 * wrong number aloud to a customer, or copies it into a tax portal, and nothing
 * anywhere reports an error because the underlying string was always correct.
 *
 * The same applies to IBANs, account codes ("4120 · Sales"), version strings,
 * file paths, and any amount rendered with a currency code.
 *
 * `<LtrText>` pins those to left-to-right regardless of the page. It is a
 * two-character fix for a class of bug that is otherwise very hard to notice
 * and very embarrassing to explain.
 */
import type { ReactNode } from 'react';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';

/**
 * Force left-to-right for content that carries its own order.
 *
 * `isolate` rather than `embed`: isolation stops the run from affecting the
 * ordering of the text AROUND it, which `dir="ltr"` alone does not guarantee.
 */
export function LtrText({
  children,
  className,
  as: Tag = 'span',
}: {
  children: ReactNode;
  className?: string;
  as?: 'span' | 'div' | 'td' | 'output';
}) {
  return (
    <Tag dir="ltr" className={cn('[unicode-bidi:isolate]', className)}>
      {children}
    </Tag>
  );
}

/**
 * Scope a subtree to the app's direction.
 *
 * Useful for content rendered outside the React root — a portal, a print frame,
 * a PDF preview — which does not inherit `<html dir>`.
 */
export function RTLWrapper({ children, className }: { children: ReactNode; className?: string }) {
  const { direction, language } = useLanguage();
  return (
    <div dir={direction} lang={language} className={className}>
      {children}
    </div>
  );
}

/**
 * Scope a subtree to an EXPLICIT direction, independent of the app's language.
 *
 * The case this exists for: rendering an invoice in the customer's language
 * while the operator's interface stays in theirs. The document is Arabic; the
 * screen around it is English.
 */
export function DirectionScope({
  direction,
  language,
  children,
  className,
}: {
  direction: 'ltr' | 'rtl';
  language: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div dir={direction} lang={language} className={className}>
      {children}
    </div>
  );
}
