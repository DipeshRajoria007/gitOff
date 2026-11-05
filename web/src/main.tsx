import '@primer/primitives/dist/css/primitives.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import 'github-markdown-css/github-markdown.css';
import './styles.css';

import { BaseStyles, ThemeProvider } from '@primer/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { applyTheme, primerColorMode, useTheme } from './lib/theme';

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Everything comes from the local server, so it's always fast; the event
      // stream tells us when to refetch. networkMode 'always' keeps queries
      // running while the browser itself reports being offline.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
      networkMode: 'always',
    },
    mutations: { networkMode: 'always' },
  },
});

function Themed({ children }: { children: ReactNode }) {
  const mode = useTheme();
  return (
    <ThemeProvider colorMode={primerColorMode(mode)} dayScheme="light" nightScheme="dark">
      <BaseStyles>{children}</BaseStyles>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Themed>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </Themed>
  </StrictMode>,
);
