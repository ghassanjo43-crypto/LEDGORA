import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './components/shell/AppShell';
import './index.css';
import './styles/rtl.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
