import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import '@blackbox/ui/styles/prototype.css';
import '@blackbox/ui/styles/extensions.css';
import { App } from './App';
import { SessionProvider } from './auth/SessionContext';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
