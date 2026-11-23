// src/main.ts — entry point: base styles first, then the composition root.
import './styles/tokens.css';
import './styles/layout.css';
import { createApp } from './app/App';

createApp(document.getElementById('app')!).catch((err: unknown) => {
  console.error('[mdr] startup failed', err);
});
