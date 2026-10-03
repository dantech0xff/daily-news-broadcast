import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';

import { createApiClient } from './api/client';
import { App, APP_ROUTES } from './app/app';
import { createQueryClient } from './app/query-client';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('The #root element is missing from index.html');

const client = createApiClient();
const queryClient = createQueryClient();
const router = createBrowserRouter(APP_ROUTES);

createRoot(root).render(
  <StrictMode>
    <App client={client} queryClient={queryClient} router={router} />
  </StrictMode>,
);
