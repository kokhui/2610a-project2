// SG Stop Pulse — frontend
const $ = (s) => document.querySelector(s);
const TAXI_RADIUS = 500;

const state = {
  stops: {},        // code -> [lng, lat, name, road]
  stopList: [],     // [{code, lat, lng, name, road}]
  services: {},     // no -> {name, routes: [[codes], [codes]]}
  routes: null,     // no -> [encoded polylines] (lazy)
  stop: null,       // selected stop object
  arrivals: [],
  conditions: null,
  service: null,    // selected service no
  timers: [],
};

// ---------- map ----------
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([1.3521, 103.8198], 12);
L.control.zoom({ position: "bottomleft" }).addTo(map);
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
// OneMap (SLA) tiles: Singapore's official basemap, and it works from file:// (no Referer needed).
L.tileLayer(`https://www.onemap.gov.sg/maps/tiles/${dark ? "Night" : "Default"}/{z}/{x}/{y}.png`, {
  minZoom: 11,
  maxZoom: 19,
  bounds: [[1.144, 103.535], [1.494, 104.1]],
  attribution: '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> &copy; contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
}).addTo(map);

const renderer = L.canvas({ padding: 0.3 });
const layers = {
  stops: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  taxis: L.layerGroup().addTo(map),
  buses: L.layerGroup().addTo(map),
  selected: L.layerGroup().addTo(map),
};
const ACCENT = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d6336c";

// Pan so a point lands in the visible part of the map (not under the panel).
function focusOn(lat, lng, zoom = 17) {
  const mobile = innerWidth <= 720;
  const panel = $("#panel").getBoundingClientRect();
  const pt = map.project([lat, lng], zoom);
  const off = mobile ? L.point(0, panel.height / 2) : L.point((panel.width + 24) / 2, 0);
  map.flyTo(map.unproject(pt.add(off), zoom), zoom, { duration: 0.8 });
}
function fitPadded(bounds) {
  const mobile = innerWidth <= 720;
  const panel = $("#panel").getBoundingClientRect();
  map.fitBounds(bounds, {
    paddingTopLeft: [30, 30],
    paddingBottomRight: mobile ? [30, panel.height + 30] : [panel.width + 50, 30],
  });
}

// ---------- utils ----------
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0;
  const out = [];
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const minsUntil = (iso) => (iso ? Math.max(0, Math.floor((new Date(iso) - Date.now()) / 60000)) : null);
const stopName = (code) => (state.stops[code] ? state.stops[code][2] : code);

// ---------- public APIs (all CORS-enabled, no key needed) ----------
const API = {
  stops: "https://data.busrouter.sg/v1/stops.min.json",
  services: "https://data.busrouter.sg/v1/services.min.json",
  routes: "https://data.busrouter.sg/v1/routes.min.json",
  arrivals: (id) => `https://arrivelah2.busrouter.sg/?id=${id}`,
  forecast: "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast",
  rainfall: "https://api-open.data.gov.sg/v2/real-time/api/rainfall",
  temperature: "https://api-open.data.gov.sg/v2/real-time/api/air-temperature",
  psi: "https://api-open.data.gov.sg/v2/real-time/api/psi",
  taxis: "https://api.data.gov.sg/v1/transport/taxi-availability",
};
const MIN = 60e3;

// data.gov.sg's keyless tier allows only a few calls per ~5 s window and answers 429 beyond that.
async function fetchWithBackoff(url, tries = 4) {
  for (let i = 1; ; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status !== 429 || i >= tries) throw new Error(`${url} → ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 2000 * i));
  }
}

// Small in-memory cache so hopping between stops doesn't refetch islandwide data.
const cache = new Map();
async function getJSON(url, ttl = 0) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fetchWithBackoff(url);
  cache.set(url, { at: Date.now(), promise });
  promise.catch(() => cache.delete(url));
  return promise;
}

function nearest(list, lat, lng, getLL) {
  let best = null, bestD = Infinity;
  for (const item of list) {
    const [a, b] = getLL(item);
    const d = distM(lat, lng, a, b);
    if (d < bestD) { bestD = d; best = item; }
  }
  return best && { item: best, distance: Math.round(bestD) };
}

// Nearest weather station that reported a value in the latest reading.
function nearestReading(payload, lat, lng) {
  const d = payload.data;
  const latest = d.readings[0];
  const values = new Map(latest.data.map((r) => [r.stationId, r.value]));
  const n = nearest(d.stations.filter((s) => values.has(s.id)), lat, lng, (s) => [s.location.latitude, s.location.longitude]);
  return n && { station: n.item.name, distance: n.distance, value: values.get(n.item.id), unit: d.readingUnit };
}

// Everything happening around a point: forecast, rain, temp, PSI, nearby taxis.
async function fetchConditions(lat, lng, radius) {
  const [fc, rain, temp, psi, taxi] = await Promise.allSettled([
    getJSON(API.forecast, 5 * MIN),
    getJSON(API.rainfall, 2 * MIN),
    getJSON(API.temperature, 2 * MIN),
    getJSON(API.psi, 15 * MIN),
    getJSON(API.taxis, 1 * MIN),
  ]);
  const out = {};
  if (fc.status === "fulfilled") {
    const d = fc.value.data;
    const area = nearest(d.area_metadata, lat, lng, (a) => [a.label_location.latitude, a.label_location.longitude]);
    const f = d.items[0].forecasts.find((x) => x.area === area.item.name);
    out.forecast = { area: area.item.name, forecast: f && f.forecast };
  }
  if (rain.status === "fulfilled") out.rain = nearestReading(rain.value, lat, lng);
  if (temp.status === "fulfilled") out.temperature = nearestReading(temp.value, lat, lng);
  if (psi.status === "fulfilled") {
    const d = psi.value.data;
    const region = nearest(d.regionMetadata.filter((r) => r.name !== "national"), lat, lng, (r) => [r.labelLocation.latitude, r.labelLocation.longitude]);
    out.psi = { region: region.item.name, psi24h: d.items[0].readings.psi_twenty_four_hourly[region.item.name] };
  }
  if (taxi.status === "fulfilled") {
    const f = taxi.value.features[0];
    const points = f.geometry.coordinates.filter(([tLng, tLat]) => distM(lat, lng, tLat, tLng) <= radius).map(([tLng, tLat]) => [tLat, tLng]);
    out.taxis = { islandwide: f.properties.taxi_count, nearby: points.length, points };
  }
  return out;
}

// ---------- bus stops on the map ----------
let stopMarkers = new Map();
function drawStops() {
  if (map.getZoom() < 15) { layers.stops.clearLayers(); stopMarkers.clear(); return; }
  const b = map.getBounds().pad(0.2);
  const keep = new Set();
  for (const s of state.stopList) {
    if (!b.contains([s.lat, s.lng])) continue;
    keep.add(s.code);
    if (stopMarkers.has(s.code)) continue;
    const m = L.circleMarker([s.lat, s.lng], {
      renderer, radius: 5, weight: 2, color: "#fff", fillColor: "#495057", fillOpacity: 1,
    }).bindTooltip(`${esc(s.name)} <span class="muted">${s.code}</span>`, { direction: "top", offset: [0, -4] });
    m.on("click", (e) => { L.DomEvent.stop(e); selectStop(s.code); });
    m.addTo(layers.stops);
    stopMarkers.set(s.code, m);
  }
  for (const [code, m] of stopMarkers) if (!keep.has(code)) { layers.stops.removeLayer(m); stopMarkers.delete(code); }
}
map.on("moveend", drawStops);

map.on("click", (e) => {
  const near = nearestStops(e.latlng.lat, e.latlng.lng, 1, 400)[0];
  if (near) selectStop(near.code);
  else L.popup().setLatLng(e.latlng).setContent("No bus stop within 400 m — try closer to a road.").openOn(map);
});

function nearestStops(lat, lng, n = 5, maxD = 400) {
  return state.stopList
    .map((s) => ({ ...s, d: distM(lat, lng, s.lat, s.lng) }))
    .filter((s) => s.d <= maxD)
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

// ---------- search ----------
const q = $("#q"), results = $("#results");
let active = -1;
q.addEventListener("input", () => {
  const term = q.value.trim().toLowerCase();
  active = -1;
  if (term.length < 2) { results.hidden = true; return; }
  const hits = state.stopList
    .filter((s) => s.code.startsWith(term) || s.name.toLowerCase().includes(term) || s.road.toLowerCase().includes(term))
    .slice(0, 12);
  results.innerHTML = hits.length
    ? hits.map((s) => `<li data-code="${s.code}"><span class="code">${s.code}</span> ${esc(s.name)} <span class="muted small">· ${esc(s.road)}</span></li>`).join("")
    : `<li class="muted">No matching stops</li>`;
  results.hidden = false;
});
q.addEventListener("keydown", (e) => {
  const items = [...results.querySelectorAll("li[data-code]")];
  if (!items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === active));
  } else if (e.key === "Enter") {
    selectStop((items[active] || items[0]).dataset.code);
  } else if (e.key === "Escape") results.hidden = true;
});
results.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-code]");
  if (li) selectStop(li.dataset.code);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) results.hidden = true; });
document.querySelectorAll("[data-stop]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); selectStop(a.dataset.stop); }));

$("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) return alert("Geolocation not supported in this browser.");
  $("#locate").textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("#locate").textContent = "◎ Near me";
      const { latitude: lat, longitude: lng } = pos.coords;
      const near = nearestStops(lat, lng, 1, 1500)[0];
      if (near) selectStop(near.code);
      else { focusOn(lat, lng, 16); alert("No bus stop within 1.5 km — are you in Singapore?"); }
    },
    (err) => { $("#locate").textContent = "◎ Near me"; alert("Couldn't get your location: " + err.message); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---------- select a stop ----------
async function selectStop(code, { fly = true } = {}) {
  const s = state.stopList.find((x) => x.code === code);
  if (!s) return;
  state.stop = s;
  state.service = null;
  state.arrivals = [];
  state.conditions = null;
  results.hidden = true;
  q.value = "";
  history.replaceState(null, "", `#stop=${code}`);

  $("#empty").hidden = true;
  $("#stop").hidden = false;
  $("#stop-name").textContent = s.name;
  $("#stop-code").textContent = s.code;
  $("#stop-road").textContent = s.road;
  $("#arrivals").innerHTML = `<li class="muted">Loading arrivals…</li>`;
  $("#conditions").innerHTML = "";
  $("#verdict").innerHTML = `<span class="big">Reading the street…</span>Checking buses, rain and taxis.`;

  layers.selected.clearLayers();
  layers.route.clearLayers();
  L.circle([s.lat, s.lng], { radius: TAXI_RADIUS, color: ACCENT, weight: 1, dashArray: "4 6", fill: false, interactive: false }).addTo(layers.selected);
  L.circleMarker([s.lat, s.lng], { radius: 9, weight: 3, color: "#fff", fillColor: ACCENT, fillOpacity: 1 }).addTo(layers.selected);
  if (fly) focusOn(s.lat, s.lng, 16);

  const nearby = nearestStops(s.lat, s.lng, 6, 350).filter((x) => x.code !== code).slice(0, 5);
  $("#nearby-h").hidden = !nearby.length;
  $("#nearby").innerHTML = nearby
    .map((x) => `<li data-code="${x.code}"><span>${esc(x.name)} <span class="muted small">${x.code}</span></span><span class="muted">${Math.round(x.d)} m</span></li>`)
    .join("");

  state.timers.forEach(clearInterval);
  state.timers = [
    setInterval(loadArrivals, 20e3),
    setInterval(loadConditions, 60e3),
    setInterval(render, 10e3), // tick countdowns between refreshes
  ];
  await Promise.all([loadArrivals(), loadConditions()]);
}
$("#nearby").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-code]");
  if (li) selectStop(li.dataset.code);
});

async function loadArrivals() {
  const code = state.stop.code;
  try {
    const data = await getJSON(API.arrivals(code));
    if (state.stop.code !== code) return;
    state.arrivals = data.services.sort((a, b) => a.no.localeCompare(b.no, undefined, { numeric: true }));
    $("#updated").textContent = "updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    console.error(e);
    $("#updated").textContent = "arrivals unavailable";
  }
  render();
}

async function loadConditions(retry = false) {
  const s = state.stop;
  try {
    const data = await fetchConditions(s.lat, s.lng, TAXI_RADIUS);
    if (state.stop !== s) return;
    // data.gov.sg rate-limits keyless calls; keep the last good value for any source that failed.
    state.conditions = { ...(state.conditions || {}), ...data };
    // A source got rate-limited and we have nothing to show for it yet: retry soon.
    if (!retry && ["forecast", "rain", "temperature", "psi", "taxis"].some((k) => !state.conditions[k])) {
      setTimeout(() => state.stop === s && loadConditions(true), 6000);
    }
  } catch (e) { console.error(e); }
  render();
}

// ---------- rendering ----------
function render() {
  renderArrivals();
  renderConditions();
  renderVerdict();
  renderBuses();
}

function timeCell(bus, label) {
  if (!bus || !bus.time) return `<div class="t none">–<small>${label}</small></div>`;
  const m = minsUntil(bus.time);
  const icons = (bus.type === "DD" ? "▣" : "") + (bus.feature === "WAB" ? "♿" : "");
  const tip = { SEA: "Seats available", SDA: "Standing available", LSD: "Limited standing" }[bus.load] || "";
  return `<div class="t ${bus.load} ${m < 1 ? "now" : ""}" title="${tip}${bus.type === "DD" ? " · double-decker" : ""}${bus.monitored ? "" : " · scheduled (not live)"}">${m < 1 ? "Arr" : m}${bus.monitored ? "" : "*"}<small>${icons || label}</small></div>`;
}

// The feed often repeats a bus across subsequent/next2/next3; keep 3 distinct arrivals.
function upcoming(svc) {
  const seen = new Set(), out = [];
  for (const b of [svc.next, svc.subsequent, svc.next2, svc.next3]) {
    if (!b || !b.time || seen.has(b.time)) continue;
    seen.add(b.time);
    out.push(b);
  }
  while (out.length < 3) out.push(null);
  return out.slice(0, 3);
}

function renderArrivals() {
  const ul = $("#arrivals");
  if (!state.arrivals.length) {
    ul.innerHTML = `<li class="muted">No buses scheduled right now.</li>`;
    return;
  }
  ul.innerHTML = state.arrivals
    .map((svc) => {
      const dest = svc.next && svc.next.destination_code ? stopName(svc.next.destination_code) : "";
      return `<li data-no="${esc(svc.no)}" class="${state.service === svc.no ? "selected" : ""}">
        <div class="svc">${esc(svc.no)}</div>
        <div><div class="dest">→ ${esc(dest)}</div><div class="op muted">${esc(svc.operator)}</div></div>
        <div class="times">${upcoming(svc).map((b, i) => timeCell(b, ["next", "2nd", "3rd"][i])).join("")}</div>
      </li>`;
    })
    .join("") +
    `<li class="legend" style="cursor:default"><span><i style="background:var(--sea)"></i>seats</span><span><i style="background:var(--sda)"></i>standing</span><span><i style="background:var(--lsd)"></i>packed</span><span>▣ double-deck · * not live</span></li>`;
}
$("#arrivals").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-no]");
  if (!li) return;
  state.service = state.service === li.dataset.no ? null : li.dataset.no;
  history.replaceState(null, "", `#stop=${state.stop.code}${state.service ? `&svc=${state.service}` : ""}`);
  render();
  drawRoute();
});

function renderConditions() {
  const c = state.conditions;
  if (!c) return;
  const cells = [];
  if (c.forecast) cells.push([forecastEmoji(c.forecast.forecast) + " " + c.forecast.forecast, `2-hr forecast · ${c.forecast.area}`]);
  if (c.rain) cells.push([`${c.rain.value} ${c.rain.unit}`, `Rain now · ${c.rain.station} (${km(c.rain.distance)})`]);
  if (c.temperature) cells.push([`${c.temperature.value}°C`, `Temp · ${c.temperature.station} (${km(c.temperature.distance)})`]);
  if (c.psi) cells.push([`PSI ${c.psi.psi24h}`, `${psiBand(c.psi.psi24h)} · ${c.psi.region}`]);
  if (c.taxis) cells.push([`🚕 ${c.taxis.nearby}`, `Taxis within ${TAXI_RADIUS} m (${c.taxis.islandwide.toLocaleString()} islandwide)`]);
  $("#conditions").innerHTML = cells.map(([v, l]) => `<div class="cond"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");

  layers.taxis.clearLayers();
  for (const [lat, lng] of (c.taxis && c.taxis.points) || []) {
    L.circleMarker([lat, lng], { renderer, radius: 4, weight: 1, color: "#000", fillColor: "#fcc419", fillOpacity: 0.95, interactive: false }).addTo(layers.taxis);
  }
}
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const isWet = (f) => /rain|shower|thunder/i.test(f || "");
function forecastEmoji(f = "") {
  if (/thunder/i.test(f)) return "⛈️";
  if (/rain|shower/i.test(f)) return "🌧️";
  if (/cloud|overcast/i.test(f)) return "☁️";
  if (/haz|mist|fog/i.test(f)) return "🌫️";
  if (/night/i.test(f)) return "🌙";
  return "☀️";
}
function psiBand(p) {
  if (p <= 50) return "Good";
  if (p <= 100) return "Moderate";
  if (p <= 200) return "Unhealthy";
  if (p <= 300) return "Very unhealthy";
  return "Hazardous";
}

// The fun part: should you wait, run, or cab?
function renderVerdict() {
  const c = state.conditions;
  const svcs = state.arrivals.filter((s) => s.next && s.next.time);
  const pool = state.service ? svcs.filter((s) => s.no === state.service) : svcs;
  if (!state.arrivals.length && !c) return;

  const soon = pool
    .map((s) => ({ no: s.no, m: minsUntil(s.next.time), load: s.next.load }))
    .sort((a, b) => a.m - b.m)[0];

  const raining = c && c.rain && c.rain.value > 0;
  const wet = raining || (c && c.forecast && isWet(c.forecast.forecast));
  const hot = c && c.temperature && c.temperature.value >= 33;
  const hazy = c && c.psi && c.psi.psi24h > 100;
  const taxis = (c && c.taxis && c.taxis.nearby) || 0;
  const who = state.service ? `Bus ${state.service}` : soon ? `Bus ${soon.no}` : "";

  let big, small;
  if (!soon) {
    big = state.service ? `No ${state.service} coming` : "No buses running";
    small = taxis ? `But ${taxis} taxi${taxis > 1 ? "s are" : " is"} within ${TAXI_RADIUS} m. 🚕` : "And no taxis nearby either. Time for a walk?";
  } else if (soon.m <= 2) {
    big = "🏃 Run!";
    small = `${who} is ${soon.m < 1 ? "arriving now" : `${soon.m} min away`}${soon.load === "LSD" ? " — but it's packed." : "."}`;
  } else if (wet && soon.m >= 10 && taxis >= 3) {
    big = "🚕 Grab a cab";
    small = `${raining ? "It's raining" : "Showers expected"} and ${who} is ${soon.m} min away. ${taxis} taxis nearby.`;
  } else if (soon.load === "LSD" && soon.m <= 10) {
    big = "😬 Sardine alert";
    small = `${who} in ${soon.m} min is packed. Consider the one after.`;
  } else if (hot && soon.m >= 6) {
    big = "🥵 Wait in the shade";
    small = `${c.temperature.value}°C out and ${who} is ${soon.m} min away.`;
  } else if (hazy) {
    big = "😷 Mask up";
    small = `PSI ${c.psi.psi24h} (${psiBand(c.psi.psi24h)}). ${who} in ${soon.m} min.`;
  } else if (soon.m >= 15) {
    big = "☕ Kopi break";
    small = `${who} is ${soon.m} min out — plenty of time.`;
  } else {
    big = "😌 Chill";
    small = `${who} in ${soon.m} min.${wet ? " Bring an umbrella. ☂️" : ""}`;
  }
  $("#verdict").innerHTML = `<span class="big">${esc(big)}</span>${esc(small)}${state.service ? "" : ` <span style="opacity:.75">Tap a service to focus.</span>`}`;
}

function renderBuses() {
  layers.buses.clearLayers();
  for (const svc of state.arrivals) {
    const focus = state.service ? svc.no === state.service : true;
    if (!focus && state.service) continue;
    const seen = new Set();
    for (const key of ["next", "subsequent", "next2", "next3"]) {
      const b = svc[key];
      if (!b || !b.lat || !b.lng || !b.time || seen.has(b.time)) continue;
      seen.add(b.time);
      if (!state.service && key !== "next") continue; // overview: only the next bus of each service
      const m = minsUntil(b.time);
      L.marker([b.lat, b.lng], {
        icon: L.divIcon({ className: "", html: `<span class="bus-marker ${state.service ? "" : "dim"}">${esc(svc.no)} · ${m < 1 ? "Arr" : m + "m"}</span>`, iconSize: null }),
        zIndexOffset: 1000,
      })
        .bindTooltip(`Bus ${esc(svc.no)} → ${esc(stopName(b.destination_code))}<br>${m < 1 ? "Arriving" : m + " min"} · ${{ SEA: "seats", SDA: "standing", LSD: "packed" }[b.load] || ""}`)
        .addTo(layers.buses);
    }
  }
}

async function drawRoute() {
  layers.route.clearLayers();
  const no = state.service;
  if (!no) { focusOn(state.stop.lat, state.stop.lng, 16); return; }
  if (!state.routes) {
    try { state.routes = await getJSON(API.routes); } catch { return; }
  }
  if (state.service !== no) return;
  const svc = state.services[no];
  const lines = state.routes[no] || [];
  // Highlight the direction that actually serves this stop.
  const dirIdx = svc ? svc.routes.findIndex((r) => r.includes(state.stop.code)) : 0;
  const all = [];
  lines.forEach((enc, i) => {
    const pts = decodePolyline(enc);
    const mine = i === dirIdx || dirIdx < 0;
    L.polyline(pts, { color: mine ? ACCENT : "#868e96", weight: mine ? 5 : 3, opacity: mine ? 0.85 : 0.4, interactive: false }).addTo(layers.route);
    if (mine) all.push(...pts);
    // stops along the route
    if (mine && svc && svc.routes[i]) {
      for (const code of svc.routes[i]) {
        const st = state.stops[code];
        if (!st) continue;
        L.circleMarker([st[1], st[0]], { renderer, radius: 3, weight: 1, color: ACCENT, fillColor: "#fff", fillOpacity: 1 })
          .bindTooltip(`${esc(st[2])} <span class="muted">${code}</span>`)
          .on("click", (e) => { L.DomEvent.stop(e); selectStop(code, { fly: false }); })
          .addTo(layers.route);
      }
    }
  });
  if (all.length) fitPadded(L.latLngBounds(all));
}

// ---------- boot ----------
(async function init() {
  try {
    const [stops, services] = await Promise.all([getJSON(API.stops), getJSON(API.services)]);
    state.stops = stops;
    state.services = services;
    state.stopList = Object.entries(stops).map(([code, [lng, lat, name, road]]) => ({ code, lat, lng, name, road }));
    $(".sub").textContent = `${state.stopList.length.toLocaleString()} stops · ${Object.keys(services).length} services · live`;
  } catch (e) {
    $("#empty").innerHTML = `<p><strong>Couldn't load bus data.</strong> Are you online?</p><p class="muted small">${esc(e.message)}</p>`;
    return;
  }
  drawStops();
  const m = location.hash.match(/stop=(\d{5})/);
  const svc = location.hash.match(/svc=([\w-]+)/);
  if (m) {
    await selectStop(m[1], { fly: !svc });
    if (svc) { state.service = svc[1]; history.replaceState(null, "", `#stop=${m[1]}&svc=${svc[1]}`); render(); drawRoute(); }
  }
})();
