/* ------------------------------------------------------------------ *
 * `addons/weather` — the addon's whole registration surface.
 *
 * One READ route and a status block. No write, so no bearer gate and no
 * Caddyfile block: `GET /api/weather` falls through to the open read handler,
 * like `GET /api/news`. Disable it and the kit is byte-identical to one that
 * never had it (docs/ADDONS.md) — the Jarvis tab then shows "weather addon not
 * enabled" instead of a reading.
 * ------------------------------------------------------------------ */
import { currentWeather, weatherConfig } from './weather.mjs'

export default function register({ Router }) {
  const routes = Router()

  routes.get('/api/weather', async (_req, res) => {
    res.json(await currentWeather())
  })

  return {
    description: 'Current weather for one configured place (Open-Meteo, no API key) — GET /api/weather, read by the Jarvis tab.',
    routes,
    status: () => {
      const cfg = weatherConfig()
      return cfg.ok
        ? { place: cfg.label || 'configured', source: 'open-meteo.com', cacheMinutes: Math.round(cfg.ttlMs / 60000) }
        : { place: 'not configured', reason: cfg.error }
    },
  }
}
