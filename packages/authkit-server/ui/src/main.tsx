import { AuthkitClientProvider, createAuthkitQueryClient } from '@adonis-agora/authkit-react';
import { QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/react';
import React from 'react';
import { createRoot } from 'react-dom/client';
import './agora-kit/fonts';
import { ThemeProvider } from './agora-kit/theme';
import { App, AUTHKIT_ACCENT } from './app';
import { getConfig } from './lib/config';
import { ToastProvider } from './lib/toast';
import './styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

const queryClient = createAuthkitQueryClient();
const config = getConfig();
const clientOptions = { baseUrl: config.endpoints.api, csrfToken: config.csrfToken ?? undefined };

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider storageKey="agora-authkit-theme" accent={AUTHKIT_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <AuthkitClientProvider opts={clientOptions}>
          <NuqsAdapter>
            <ToastProvider>
              <App />
            </ToastProvider>
          </NuqsAdapter>
        </AuthkitClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
