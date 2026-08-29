import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './components/shell/AppShell';
import { bindCompanySelector } from './services/api/companySelector';
import { bindCompanyScope } from './services/books/booksScope';
import './index.css';

/*
 * Before the first render, so no request can leave without saying which set of
 * books it concerns. Bound here rather than inside a component because it must
 * survive remounts and must not run twice under StrictMode's double-invoke.
 */
bindCompanySelector();

/*
 * And immediately after, so the cached books are dropped the moment a different
 * company is opened. The order matters: the selector must already point at the
 * new company before anything re-reads the books for it.
 */
bindCompanyScope();

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
