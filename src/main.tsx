import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Gallery } from './dev/Gallery';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === '#gallery' ? <Gallery /> : <App />}
  </StrictMode>,
);
