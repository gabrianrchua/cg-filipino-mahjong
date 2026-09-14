import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App.tsx'
import './index.css'
import { RealtimeProvider } from './realtime/RealtimeProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RealtimeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RealtimeProvider>
  </StrictMode>,
)
