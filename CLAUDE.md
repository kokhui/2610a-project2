# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

SG Stop Pulse is a static, browser-only web app that shows live data for a chosen Singapore bus stop: bus arrivals, bus positions and routes, plus weather, PSI and nearby taxis. It ends with a playful "what should you do" verdict. There is no build step, package manager, server or test suite.

**Run it** by opening `index.html` in a browser. It works over `file://`. No server is needed, by the user's explicit request, and every upstream API sends `Access-Control-Allow-Origin: *`. Do not reintroduce a proxy or local server.

`index.html` holds the layout and `style.css` the theming: tokens on `:root` with a dark-mode override, and a bottom-sheet panel under 720px. All logic is in `app.js`, which is plain JS on Leaflet 1.9.4 from cdnjs.

## Architecture (app.js)

- **The `API` object** lists every endpoint: busrouter.sg static data (stops, services, routes), arrivelah arrivals, four data.gov.sg v2 real-time feeds (forecast, rainfall, temperature, PSI), and v1 taxi availability. Every fetch goes through `getJSON(url, ttl)`, an in-memory promise cache, which wraps `fetchWithBackoff`.
- **The data.gov.sg rate limit is the main fragility.** Calls without an API key get HTTP 429 after a few requests within about 5 s. To cope, the app retries 429s with backoff, caches the islandwide feeds for 1–15 min, and `loadConditions` merges new results over the previous `state.conditions`, so a failed source keeps its last value. It also schedules a single retry while any source is still missing.
- **`fetchConditions(lat, lng, radius)`** reduces the islandwide feeds to the point the user picked: the nearest forecast area, the nearest station that reported a value, the nearest PSI region, and taxis within the radius. All distance work happens on the client (`distM`, `nearest`).
- **Data flow:** `state` holds the data. `selectStop()` resets it and starts three intervals: arrivals every 20 s, conditions every 60 s, and a countdown re-render every 10 s. `render()` then redraws the arrivals, conditions, verdict and bus markers. `renderVerdict()` is the heuristic behind the "Run / Grab a cab / Kopi break" message.
- **Map layers** live in `layers` (stops, route, taxis, buses, selected). Stop markers are drawn only at zoom 15 or closer, and only for stops near the viewport (`drawStops` on `moveend`). They use a shared canvas renderer, because there are about 5,200 stops. `focusOn` and `fitPadded` offset the view so the stop isn't hidden under the side panel.
- **Route lines:** `routes.min.json` is loaded lazily on the first service click and holds Google-encoded polylines (`decodePolyline`). `services[no].routes[i]` lists the stop codes for direction `i`, which is used to highlight the direction that serves the selected stop.
- **URL hash state:** `#stop=83139&svc=15` is read once at startup and rewritten as the selection changes.

## Data quirks

- In `stops.min.json`, each stop is `[lng, lat, name, road]`, so longitude comes first. Taxi GeoJSON coordinates are also `[lng, lat]`.
- The arrivals feed repeats the same bus across `subsequent`, `next2` and `next3`, so deduplicate by `time` (`upcoming()`). `monitored: 0` means a scheduled time rather than live GPS. A bus at `lat`/`lng` 0 has no position.
- Map tiles are OneMap (SLA). CARTO and other referer-checked tile servers show "API KEY REQUIRED" when the page is opened over `file://`.

## Verifying changes

There are no tests. Check behaviour in headless Chrome, for example: `"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --window-size=1400,900 --screenshot=out.png "file:///<abs path>/index.html#stop=83139&svc=15"`. Run `node --check app.js` for a syntax check.

Don't trust `--virtual-time-budget` for the data.gov.sg cards. It fast-forwards the backoff timers, so the retries burst into the rate limit and the cards look broken when they aren't. Wait in real time instead, for example by reading the DOM through the DevTools protocol after about 20 s. Repeated test runs also use up the rate limit, so leave about 5 s between them.
