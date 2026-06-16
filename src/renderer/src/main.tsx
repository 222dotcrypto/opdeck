import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import { installTauriBridge } from './tauri-bridge'
import './styles/index.css'
import '@xterm/xterm/css/xterm.css'

// Под Electron мост (window.api) уже поставил preload. Если его нет — мы под Tauri,
// ставим Tauri-мост. Так не зависим от точного определения среды.
// @ts-expect-error window.api ставит preload (Electron) либо мы тут (Tauri)
if (!window.api) installTauriBridge()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
