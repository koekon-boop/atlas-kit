import { render } from 'preact'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/index.css'
import { AppShell } from './components/AppShell'
import { QuickCapture } from './components/QuickCapture'
import { applyTheme, getTheme } from './lib/theme'

// Apply the saved theme before first paint to avoid a flash of the default.
applyTheme(getTheme())

// Two entry points, one SPA bundle. `/capture` (or `?view=capture` where a path
// rewrite isn't available) is the bookmarkable, home-screen-pinnable quick-
// capture surface; everything else is the dashboard. Caddy's `try_files …
// /index.html` and Vite's dev/preview server both serve index.html for
// `/capture`, so this needs no router and no server route.
const isCapture =
  /^\/capture\/?$/.test(location.pathname) ||
  new URLSearchParams(location.search).get('view') === 'capture'

const root = document.getElementById('app')
if (root) render(isCapture ? <QuickCapture /> : <AppShell />, root)
