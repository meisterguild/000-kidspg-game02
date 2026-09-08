import React from 'react';
import ReactDOM from 'react-dom/client';
import RankingPage from './pages/RankingPage';
import './styles/globals.css';
import { RankingProvider } from './contexts/RankingContext'; // ADDED

const rootElement = document.getElementById('root');
if (!rootElement) { // ADDED null check
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render( // Used rootElement
  <React.StrictMode>
    <RankingProvider>
      <RankingPage />
    </RankingProvider>
  </React.StrictMode>,
);
