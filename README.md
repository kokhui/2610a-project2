# SG Stop Pulse

Pick any Singapore bus stop and see what's happening there right now: live bus arrivals, where each bus is, its route, the local weather, haze, and taxis nearby. It finishes with a playful verdict: **🏃 Run! / 🚕 Grab a cab / 🥵 Wait in the shade / ☕ Kopi break …**

**No server, no build, no API keys.** Open `index.html` in a browser (double-click it). Every API below sends `Access-Control-Allow-Origin: *`, so the page calls them directly.

## What you can do
- **Tap the map** at zoom 15 or closer to show stops, then tap one. **Search** by stop code, name or road. **◎ Near me** uses geolocation.
- **Arrivals** refresh every 20 s. The underline colour shows how full the bus is (green = seats, amber = standing, red = packed). `*` means a scheduled time, not live GPS. ▣ = double-decker.
- **Tap a service** to draw its route (the direction serving this stop is highlighted), its stops, and every incoming bus on that route.
- **Conditions card**: 2-hr forecast for the area, rainfall in the last 5 min at the nearest gauge, nearest temperature, regional 24-h PSI, and live taxis within 500 m (yellow dots).
- Links are shareable: `index.html#stop=83139&svc=15`.

## Data sources
| What | Endpoint |
|---|---|
| Stops / services / route lines | `data.busrouter.sg/v1/{stops,services,routes}.min.json` |
| Live arrivals (LTA DataMall via arrivelah) | `arrivelah2.busrouter.sg/?id=<stop>` |
| 2-hr forecast, rainfall, temperature, PSI (NEA) | `api-open.data.gov.sg/v2/real-time/api/...` |
| Taxi availability (LTA) | `api.data.gov.sg/v1/transport/taxi-availability` |
| Basemap | OneMap (SLA) tiles |

## Notes
- data.gov.sg's keyless tier rate-limits hard: HTTP 429 after a handful of calls within about 5 s. The app retries with backoff, caches the islandwide feeds for 1–15 min, and keeps the last good value if a refresh fails.
- Files: `index.html` (layout), `style.css` (light/dark themes), `app.js` (all logic). Leaflet is loaded from cdnjs.

## Ideas to extend
- "Rain risk" heatmap: plot every rainfall gauge as a coloured circle.
- Favourite stops in `localStorage`, with a morning-commute dashboard.
- Carpark availability (`api.data.gov.sg/v1/transport/carpark-availability`) with HDB carpark locations, for a "drive or bus?" comparison.
