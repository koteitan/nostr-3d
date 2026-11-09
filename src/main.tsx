import { createRoot } from 'react-dom/client';

import { App } from './App';
import { startNostr } from './nostr';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
void startNostr();
