import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { joinFromUrl } from './collab/session';
import { isDesktop } from './io/files';
import { startVersionHistory } from './io/versionStore';
import './styles/app.css';

// Dev-only visual review page. Lazily imported and gated on DEV so Vite can
// drop it (and its imports) entirely from production web/desktop builds.
const Gallery = import.meta.env.DEV
  ? lazy(() => import('./dev/Gallery').then((m) => ({ default: m.Gallery })))
  : null;

const showGallery = import.meta.env.DEV && Gallery !== null && location.hash.startsWith('#gallery');

if (!showGallery) {
  joinFromUrl();
  startVersionHistory();
}

// installable, offline-capable web app (the desktop app ships its files itself)
if (import.meta.env.PROD && !isDesktop() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// Dev-only handle for scripted UI checks (headless screenshots).
if (import.meta.env.DEV) void import('./store/store').then((m) => Object.assign(window, { __nodal: m }));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {showGallery && Gallery ? (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
