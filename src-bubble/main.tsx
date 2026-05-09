import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BubbleChat } from './BubbleChat';
import './globals.css';

const container = document.getElementById('bubble-root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <BubbleChat />
    </StrictMode>,
  );
}
