import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installNetworkCredential, rememberShareCode } from './lib/util';
import './styles.css';

installNetworkCredential();
rememberShareCode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
