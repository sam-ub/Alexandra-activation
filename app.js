(function () {
  // US EPA PM2.5 AQI categories (2024 24-hour breakpoints, µg/m³).
  const AQI_BANDS = [
    { min: 0,     max: 9.0,   label: 'Good',           fill: 'rgba(38,166,91,0.24)',  bar: '#2EA35B', text: '#1F7A44' },
    { min: 9.0,   max: 35.4,  label: 'Moderate',       fill: 'rgba(232,196,42,0.26)', bar: '#E3C42A', text: '#9C7E08' },
    { min: 35.4,  max: 55.4,  label: 'Unhealthy (SG)', fill: 'rgba(230,138,42,0.26)', bar: '#E68A2A', text: '#C06A15' },
    { min: 55.4,  max: 125.4, label: 'Unhealthy',      fill: 'rgba(220,59,42,0.26)',  bar: '#DC3B2A', text: '#B42E1F' },
    { min: 125.4, max: 1e4, label: 'Very Unhealthy', fill: 'rgba(255, 0, 0,0.26)', bar: '#FF0000', text: '#6A2378' }
  ];
  const GAUGE_MAX = 60; // µg/m³ shown on the category gauge
  const UNNTAGGED_LABEL = '(Untagged)';
  function aqiCategory(v) { for (const b of AQI_BANDS) { if (v <= b.max) return b; } return AQI_BANDS[AQI_BANDS.length - 1]; }
  const GAUGE_TICKS = [0, 9, 35, 55];
  function renderGaugeAxis() {
    const el = document.getElementById('gaugeAxis');
    if (!el) return;
    const ticks = GAUGE_TICKS.map(v => {
      const pct = (v / GAUGE_MAX) * 100;
      const edge = v === 0 ? ' edge-start' : '';
      const style = v === 0 ? 'left:0' : `left:${pct}%`;
      const transform = v === 0 ? '' : 'transform:translateX(-50%)';
      return `<span class="g-tick${edge}" style="${style};${transform}">${v}</span>`;
    }).join('');
    el.innerHTML = `<div class="g-axis-line"></div>${ticks}`;
  }

  // AirBeam 3 session export (AirCasting wide CSV).
  const AIRBEAM_FILES = [
    'data/alexandra_activation_1972483__20260828-583192-m86dci.csv',
  ];
  // SpotterOn observations export (semicolon-delimited). Filtered to this activation.
  const SPOTS_FILE = 'data/urbanbetter_spots_20260828155620.csv';
  const SPOTS_FILTER = {
    datePrefix: '2026-08-28',
    // Alexandra activation area
    minLat: -26.15, maxLat: -26.05,
    minLon: 28.08, maxLon: 28.15,
  };

  const MIN_ROWS = 100;   // drop very short / aborted sessions
  const CHART_Y_MAX = 150;

  // ---------- Map base ----------
  const map = L.map('map', { zoomControl: true, scrollWheelZoom: true });
  L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=7a892008-752a-4a39-bd1b-58417e3a0331', {
    maxZoom: 20,
    attribution: '&copy; Stadia Maps &copy; OpenMapTiles &copy; OpenStreetMap'
  }).addTo(map);
  map.setView([-25.7513, 28.2591], 17);

  // ---------- Shared helpers ----------
  function haversine(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const withUnit = (val, unit) => `${val}<span class="u">${unit}</span>`;
  const titleCase = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const escapeHtml = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function showLoadError(elementId, { title, stage, error, hints }) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const msg = error && (error.message || String(error));
    const hintHtml = hints && hints.length
      ? `<ul class="le-hints">${hints.map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
      : '';
    el.innerHTML = `
      <div class="load-error">
        ${stage ? `<div class="le-stage">Failed at: ${escapeHtml(stage)}</div>` : ''}
        <div class="le-title">${escapeHtml(title)}</div>
        ${msg ? `<div class="le-detail">${escapeHtml(msg)}</div>` : ''}
        ${hintHtml}
      </div>`;
  }

  function loadHints() {
    const hints = [];
    if (location.protocol === 'file:') {
      hints.push('You opened this page via file:// — use a local server instead.');
    }
    hints.push('Run: python -m http.server 8000 in the Activation folder.');
    hints.push('Open: http://localhost:8000/index.html');
    hints.push('Hard refresh with DevTools → Network → Disable cache.');
    return hints;
  }

  const SENSOR_COLORS = ['#E8593C', '#1F5C3F', '#3B6EA5', '#D69A2D', '#8E44AD', '#127475', '#B5651D'];
  const shortId = (file, fallback) => {
    const mac = file.match(/AirBeam3[_:]([0-9a-f]+)/i);
    if (mac) return mac[1].slice(-4);
    const sess = file.match(/_(\d{6,})__/);
    if (sess) return sess[1].slice(-4);
    return fallback || '';
  };

  const parseTime = s => {
    if (!s) return NaN;
    const t = Date.parse(String(s).trim().replace(' ', 'T'));
    return isFinite(t) ? t : NaN;
  };
  const fmtHM = ms => {
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };
  const isNum = v => Number.isFinite(v); // rejects null (isFinite(null) wrongly passes)

  function downsample(pts, max) {
    if (pts.length <= max) return pts.slice();
    const step = pts.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  // Quote-aware CSV/DSV parser -> array of objects keyed by header row.
  function parseCSV(text, delim) {
    const rows = [];
    let field = '', row = [], q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else {
        if (c === '"') q = true;
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.trim());
    return rows.slice(1)
      .filter(r => r.length > 1)
      .map(r => {
        const o = {};
        header.forEach((h, idx) => { o[h] = (r[idx] || '').trim(); });
        return o;
      });
  }

  // AirCasting "wide" export: multi-row metadata, then ObjectID,Session_Name,Timestamp,...
  function parseAirCastingWide(text) {
    const raw = [];
    let field = '', row = [], q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); raw.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
      }
    }
    if (field.length || row.length) { row.push(field); raw.push(row); }

    const headerIdx = raw.findIndex(r => (r[0] || '').trim() === 'ObjectID');
    if (headerIdx < 0) return { rows: [], sensorId: '' };

    let pmCol = -1;
    let sensorId = '';
    for (let i = 0; i < headerIdx; i++) {
      const cells = raw[i].map(c => (c || '').trim());
      cells.forEach((c, idx) => {
        if (/^AirBeam3:[0-9a-f]+$/i.test(c) && !sensorId) sensorId = c.split(':')[1];
        if (/PM2\.?5/i.test(c)) pmCol = idx;
      });
    }
    const header = raw[headerIdx].map(h => (h || '').trim());
    if (pmCol < 0) {
      pmCol = header.findIndex(h => /^4:Measurement_Value$/i.test(h));
    }
    const latCol = header.findIndex(h => /^Latitude$/i.test(h));
    const lonCol = header.findIndex(h => /^Longitude$/i.test(h));
    const timeCol = header.findIndex(h => /^Timestamp$/i.test(h));
    if (pmCol < 0 || latCol < 0 || lonCol < 0 || timeCol < 0) return { rows: [], sensorId };

    const rows = [];
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i];
      if (!r || r.length < 2) continue;
      rows.push({
        latitude: (r[latCol] || '').trim(),
        longitude: (r[lonCol] || '').trim(),
        time: (r[timeCol] || '').trim(),
        pm2_5: (r[pmCol] || '').trim(),
      });
    }
    return { rows, sensorId };
  }

  function airbeamRowsFromText(text) {
    if (/Sensor_Package_Name|^\s*ObjectID,/m.test(text) && /Timestamp/i.test(text)) {
      return parseAirCastingWide(text);
    }
    return { rows: parseCSV(text, ','), sensorId: '' };
  }

  function spotInActivation(sp) {
    if (!SPOTS_FILTER) return true;
    const { datePrefix, minLat, maxLat, minLon, maxLon } = SPOTS_FILTER;
    if (datePrefix) {
      const when = sp.time || '';
      // normalizeSpot stores SPOTTED_AT on .time; also allow CREATED_AT via raw check below
      if (!String(when).startsWith(datePrefix)) return false;
    }
    if (isFinite(minLat) && sp.lat < minLat) return false;
    if (isFinite(maxLat) && sp.lat > maxLat) return false;
    if (isFinite(minLon) && sp.lon < minLon) return false;
    if (isFinite(maxLon) && sp.lon > maxLon) return false;
    return true;
  }

  // ---------- Sensor position marker (moves on chart hover) ----------
  const sensorPingIcon = L.divIcon({ className: '', html: `<div class="sensor-ping"></div>`, iconSize: [14, 14] });
  let denseTrack = [];      // one [lat,lon] per chart x-position (primary sensor)
  let sensorMarker = null;
  let chartPointCount = 0;

  function setupHover(track) {
    denseTrack = track;
    if (!sensorMarker && track.length) {
      sensorMarker = L.marker(track[0], { icon: sensorPingIcon, interactive: false }).addTo(map);
      sensorMarker.setOpacity(0);
    }
  }
  function moveSensorMarkerTo(index) {
    if (!sensorMarker || !denseTrack.length) return;
    // denseTrack is aligned 1:1 with the chart x-axis, so map index -> coordinate directly.
    let di = index;
    if (denseTrack.length !== chartPointCount) {
      di = Math.round((index / Math.max(1, chartPointCount - 1)) * (denseTrack.length - 1));
    }
    di = Math.max(0, Math.min(denseTrack.length - 1, di));
    if (denseTrack[di]) { sensorMarker.setLatLng(denseTrack[di]); sensorMarker.setOpacity(1); }
  }
  function hideSensorMarker() { if (sensorMarker) sensorMarker.setOpacity(0); }

  // ---------- Route drawing ----------
  // AQI-coloured points along the primary sensor track (one per time bin).
  function drawRoute(routePoints, distMeters) {
    if (!routePoints || !routePoints.length) return;

    const bounds = [];
    routePoints.forEach(pt => {
      const cat = aqiCategory(pt.pm);
      L.circleMarker([pt.lat, pt.lon], {
        radius: 5,
        color: cat.bar,
        weight: 1,
        opacity: 0.9,   // match fillOpacity so the outline doesn't read as a ring
        fillColor: cat.bar,
        fillOpacity: 0.9,
      }).addTo(map).bindTooltip(`${pt.pm.toFixed(1)} µg/m³ · ${cat.label}`);
      bounds.push([pt.lat, pt.lon]);
    });

    const first = routePoints[0], last = routePoints[routePoints.length - 1];
    const endpointIcon = (kind, label) => L.divIcon({
      className: 'route-endpoint-icon',
      html: `<div class="route-endpoint ${kind}"><span class="ep-label">${label}</span><span class="ep-pin"></span><span class="ep-dot"></span></div>`,
      iconSize: [72, 42],
      iconAnchor: [36, 42],
    });
    L.marker([first.lat, first.lon], { icon: endpointIcon('start', 'Start'), interactive: false, zIndexOffset: 600 }).addTo(map);
    L.marker([last.lat, last.lon], { icon: endpointIcon('finish', 'Finish'), interactive: false, zIndexOffset: 600 }).addTo(map);

    map.fitBounds(L.latLngBounds(bounds).pad(0.25));
    if (isFinite(distMeters)) {
      document.getElementById('mRoute').textContent = `${(distMeters / 1000).toFixed(2)} km`;
    }
  }

  // ---------- Observation "spots" ----------
  let allSpots = [];
  let spotClusterGroup = null;
  let activeCategories = new Set();

  function pickImage(spot) {
    if (spot.IMAGE && /^https?:/.test(spot.IMAGE)) return spot.IMAGE;
    if (spot.IMAGE_ON_THE_MOVE && /^https?:/.test(spot.IMAGE_ON_THE_MOVE)) return spot.IMAGE_ON_THE_MOVE;
    for (const k of Object.keys(spot)) {
      if (k.startsWith('MEDIA_') && /^https?:\/\/dl\.spotteron/.test(spot[k])) return spot[k];
    }
    return '';
  }
  const splitTags = v => (v || '').split(',').map(t => t.trim()).filter(Boolean);

  function normalizeSpot(s) {
    const lat = +s.LATITUDE, lon = +s.LONGITUDE;
    if (!isFinite(lat) || !isFinite(lon) || (!lat && !lon)) return null;
    const posTags = splitTags(s.POSITIVE_FEATURES_SPOT).map(titleCase);
    const negTags = splitTags(s.NEGATIVE_FEATURES_SPOT).map(titleCase);
    const categories = [...new Set([...posTags, ...negTags])];
    const type = negTags.length ? 'negative' : (posTags.length ? 'positive' : 'neutral');
    return {
      id: s.ID || s.ROOT_ID || '',
      lat, lon, type, posTags, negTags, categories,
      image: pickImage(s),
      desc: s.DESCRIPTION || '',
      time: s.SPOTTED_AT || ''
    };
  }

  function spotMatchesFilter(sp) {
    if (!activeCategories.size) return false;
    if (sp.type === 'neutral') return activeCategories.has(UNNTAGGED_LABEL);
    return sp.categories.some(c => activeCategories.has(c));
  }

  function buildCategoryList(spots) {
    const counts = {};
    spots.forEach(sp => {
      if (sp.type === 'neutral') {
        counts[UNNTAGGED_LABEL] = (counts[UNNTAGGED_LABEL] || 0) + 1;
      } else {
        sp.categories.forEach(c => { counts[c] = (counts[c] || 0) + 1; });
      }
    });
    return Object.entries(counts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }

  // One open image-popup per nearby group (matches cluster radius). Prefer spots with photos.
  const POPUP_GROUP_M = 80;
  function pickDefaultPopupSpots(spots) {
    const ranked = [...spots].sort((a, b) => {
      const ai = a.image ? 1 : 0, bi = b.image ? 1 : 0;
      if (bi !== ai) return bi - ai;
      return String(b.time).localeCompare(String(a.time));
    });
    const chosen = [];
    ranked.forEach(sp => {
      const near = chosen.some(c => haversine([c.lat, c.lon], [sp.lat, sp.lon]) < POPUP_GROUP_M);
      if (!near) chosen.push(sp);
    });
    return chosen;
  }

  function spotPopupHtml(sp) {
    const typeLabel = sp.type === 'negative' ? 'Negative observation'
      : sp.type === 'positive' ? 'Positive observation' : 'Observation (untagged)';
    return `
      <div class="popup-card">
        ${sp.image ? `<img src="${escapeHtml(sp.image)}" alt="observation" onerror="this.style.display='none'"/>` : ''}
        ${sp.id ? `<div class="pnote" style="margin-top:4px;opacity:.75">ID: ${escapeHtml(String(sp.id))}</div>` : ''}
        <div class="ptype ${sp.type}">${typeLabel}</div>
        ${sp.posTags.length ? `<div class="plabel" style="color:var(--green)">+ ${escapeHtml(sp.posTags.join(', '))}</div>` : ''}
        ${sp.negTags.length ? `<div class="plabel" style="color:var(--coral-deep)">− ${escapeHtml(sp.negTags.join(', '))}</div>` : ''}
        ${sp.desc ? `<div class="pnote">${escapeHtml(sp.desc)}</div>` : ''}
        ${sp.time ? `<div class="pnote" style="margin-top:4px;opacity:.65">${escapeHtml(sp.time)}</div>` : ''}
      </div>`;
  }

  function makeClusterGroup() {
    return L.markerClusterGroup({
      maxClusterRadius: 50,
      iconCreateFunction: (cluster) => {
        let pos = 0, neg = 0;
        cluster.getAllChildMarkers().forEach(m => {
          if (m.options.spotType === 'negative') neg++;
          else if (m.options.spotType === 'positive') pos++;
        });
        const bg = neg > pos ? '#E8593C' : pos > neg ? '#1F5C3F' : '#6B6A5F';
        const fg = neg > pos ? '#fff' : '#C6E24E';
        const count = cluster.getChildCount();
        const size = count > 9 ? 38 : 32;
        return L.divIcon({
          html: `<div class="cluster-marker" style="width:${size}px;height:${size}px;background:${bg};color:${fg};">${count}</div>`,
          className: '',
          iconSize: null,
        });
      }
    });
  }

  function makeSpotMarker(sp) {
    const icon = L.divIcon({
      className: '',
      html: `<div class="feature-marker ${sp.type}"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    const marker = L.marker([sp.lat, sp.lon], {
      icon,
      spotType: sp.type,
      spotKey: `${sp.lat.toFixed(6)},${sp.lon.toFixed(6)},${sp.time}`,
    });
    marker.bindPopup(spotPopupHtml(sp), {
      className: 'spot-popup',
      closeButton: true,
      maxWidth: 220,
      autoClose: false,
      closeOnClick: false,
      autoPan: false,
    });
    return marker;
  }

  function applyCategoryFilter() {
    if (!spotClusterGroup) return;
    map.closePopup();
    spotClusterGroup.clearLayers();
    const visible = allSpots.filter(spotMatchesFilter);
    visible.map(sp => {
      const m = makeSpotMarker(sp);
      spotClusterGroup.addLayer(m);
      return m;
    });
  }

  function setupMapFilter(categories) {
    activeCategories = new Set(categories.map(c => c.label));
    const body = document.getElementById('mapFilterBody');
    const panel = document.getElementById('mapFilter');
    const toggle = document.getElementById('mapFilterToggle');

    const allChecked = activeCategories.size === categories.length;
    body.innerHTML = `
      <label class="mf-all"><input type="checkbox" id="mfAll" ${allChecked ? 'checked' : ''}> All categories</label>
      ${categories.map(c => `
        <label class="mf-item${c.label === UNNTAGGED_LABEL ? ' untagged' : ''}">
          <input type="checkbox" class="mf-cb" value="${escapeHtml(c.label)}" checked>
          <span>${escapeHtml(c.label)}</span>
          <span class="mf-count">${c.count}</span>
        </label>`).join('')}`;

    toggle.onclick = () => {
      const collapsed = panel.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
    };

    const syncAllCheckbox = () => {
      const cbs = body.querySelectorAll('.mf-cb');
      document.getElementById('mfAll').checked = [...cbs].every(cb => cb.checked);
    };

    document.getElementById('mfAll').onchange = (e) => {
      const on = e.target.checked;
      body.querySelectorAll('.mf-cb').forEach(cb => { cb.checked = on; });
      activeCategories = on ? new Set(categories.map(c => c.label)) : new Set();
      applyCategoryFilter();
    };

    body.querySelectorAll('.mf-cb').forEach(cb => {
      cb.onchange = () => {
        activeCategories = new Set([...body.querySelectorAll('.mf-cb:checked')].map(c => c.value));
        syncAllCheckbox();
        applyCategoryFilter();
      };
    });
  }

  function updateObsSummary(spots) {
    const posN = spots.filter(s => s.type === 'positive').length;
    const negN = spots.filter(s => s.type === 'negative').length;
    const neuN = spots.filter(s => s.type === 'neutral').length;
    const total = spots.length;

    document.getElementById('kObs').textContent = total;
    document.getElementById('kObsSub').textContent = `${posN} pos · ${negN} neg · ${neuN} neu`;

    const denom = total || 1;
    document.getElementById('rPos').style.width = `${(posN / denom) * 100}%`;
    document.getElementById('rNeg').style.width = `${(negN / denom) * 100}%`;
    document.getElementById('rNeu').style.width = `${(neuN / denom) * 100}%`;
    document.getElementById('rPosN').textContent = posN;
    document.getElementById('rNegN').textContent = negN;
    document.getElementById('rNeuN').textContent = neuN;
  }

  function renderSpots(spots) {
    allSpots = spots;
    if (spotClusterGroup) map.removeLayer(spotClusterGroup);
    spotClusterGroup = makeClusterGroup();
    map.addLayer(spotClusterGroup);

    const categories = buildCategoryList(spots);
    setupMapFilter(categories);
    applyCategoryFilter();
    updateObsSummary(spots);

    const cats = {};
    spots.forEach(s => {
      s.posTags.forEach(t => { (cats[t] = cats[t] || { label: t, pos: 0, neg: 0, neu: 0 }).pos++; });
      s.negTags.forEach(t => { (cats[t] = cats[t] || { label: t, pos: 0, neg: 0, neu: 0 }).neg++; });
    });
    const untaggedN = spots.filter(s => s.type === 'neutral').length;
    if (untaggedN) cats[UNNTAGGED_LABEL] = { label: UNNTAGGED_LABEL, pos: 0, neg: 0, neu: untaggedN };
    renderBreakdown(Object.values(cats));
  }

  function renderBreakdown(items) {
    const sorted = items.map(i => ({ ...i, total: (i.pos || 0) + (i.neg || 0) + (i.neu || 0) }))
      .sort((a, b) => b.total - a.total).slice(0, 14);
    const rows = sorted.map(i => `
      <tr class="${i.label === UNNTAGGED_LABEL ? 'untagged-row' : ''}">
        <td class="cat" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</td>
        <td class="pos">${i.pos || ''}</td>
        <td class="neg">${i.neg || ''}</td>
        <td class="neu">${i.neu || ''}</td>
        <td class="tot">${i.total}</td>
      </tr>`).join('');
    document.getElementById('issueBars').innerHTML =
      `<table class="cat-table">
        <thead><tr><th class="cat">Category</th><th>Pos</th><th>Neg</th><th>Neu</th><th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ---------- Sessions & time series ----------
  function parseSession(rows) {
    const pts = [];
    for (const r of rows) {
      const lat = +r.latitude, lon = +r.longitude, pm = +r.pm2_5, t = parseTime(r.time);
      // Drop missing GPS/time and zero PM2.5 readings (sensor glitches / placeholders).
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(pm) || !isFinite(t) || pm <= 0) continue;
      pts.push({ t, lat, lon, pm });
    }
    if (pts.length < 2) return null;
    pts.sort((a, b) => a.t - b.t);
    let dist = 0;
    const track = [];
    for (let i = 0; i < pts.length; i++) {
      track.push([pts[i].lat, pts[i].lon]);
      if (i) dist += haversine(track[i - 1], track[i]);
    }
    return { pts, track, dist, count: pts.length };
  }

  // Nearest-neighbour fill for gaps in the hover coordinate track.
  function fillCoordNulls(a) {
    const first = a.findIndex(x => x);
    if (first < 0) return;
    for (let i = 0; i < first; i++) a[i] = a[first];
    let last = first;
    for (let i = first + 1; i < a.length; i++) { if (a[i]) last = i; else a[i] = a[last]; }
  }

  // One chart/map point per raw reading (no time aggregation).
  function buildTimeSeries(sessions, primary) {
    const timeSet = new Set();
    sessions.forEach(s => s.pts.forEach(p => timeSet.add(p.t)));
    const times = [...timeSet].sort((a, b) => a - b);
    const labels = times.map(fmtHM);

    const series = sessions.map((s, i) => {
      const byT = new Map(s.pts.map(p => [p.t, p.pm]));
      return {
        label: 'AirBeam ' + (s.id || (i + 1)),
        data: times.map(t => (byT.has(t) ? +(+byT.get(t)).toFixed(1) : null)),
        color: SENSOR_COLORS[i % SENSOR_COLORS.length],
      };
    });

    const byTPrimary = new Map(primary.pts.map(p => [p.t, p]));
    const coordTrack = times.map(t => {
      const p = byTPrimary.get(t);
      return p ? [p.lat, p.lon] : null;
    });
    fillCoordNulls(coordTrack);

    const routePoints = primary.pts.map(p => ({ lat: p.lat, lon: p.lon, pm: p.pm }));

    return { labels, series, coordTrack, routePoints };
  }

  // ---------- Chart background: EPA AQI colour bands ----------
  const aqiBandsPlugin = {
    id: 'aqiBands',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
      ctx.save();
      AQI_BANDS.forEach(band => {
        if (band.min > y.max) return;
        let yTop = y.getPixelForValue(Math.min(band.max, y.max));
        let yBot = y.getPixelForValue(Math.max(band.min, y.min));
        yTop = Math.max(top, Math.min(bottom, yTop));
        yBot = Math.max(top, Math.min(bottom, yBot));
        if (yBot <= yTop) return;
        ctx.fillStyle = band.fill;
        ctx.fillRect(left, yTop, right - left, yBot - yTop);
      });
      ctx.restore();
    }
  };

  // ---------- Chart + PM stats ----------
  // series: [{ label, data:[per-reading values, may contain null], color }]
  function renderPM({ labels, series, totalReadings, xTitle, sourceNote }) {
    chartPointCount = labels.length;

    // Aggregate across sensors (ignoring gaps) for the KPI strip / insight panel.
    const meanLine = [];
    let maxSpread = 0;
    for (let b = 0; b < labels.length; b++) {
      const vals = series.map(s => s.data[b]).filter(isNum);
      if (!vals.length) continue;
      meanLine.push(vals.reduce((a, c) => a + c, 0) / vals.length);
      if (vals.length > 1) maxSpread = Math.max(maxSpread, Math.max(...vals) - Math.min(...vals));
    }
    let readingMean = meanLine.length
      ? meanLine.reduce((a, b) => a + b, 0) / meanLine.length
      : 0;

    // Peak / min: highest and lowest reading on any sensor line (matches chart tooltips).
    let peak = -Infinity, peakSensor = '';
    let min = Infinity, minSensor = '';
    series.forEach(s => {
      s.data.forEach(v => {
        if (!isNum(v)) return;
        if (v > peak) { peak = v; peakSensor = s.label; }
        if (v < min) { min = v; minSensor = s.label; }
      });
    });
    if (!isNum(peak)) { peak = 0; peakSensor = '—'; }
    if (!isNum(min)) { min = 0; minSensor = '—'; }
    const cat = aqiCategory(readingMean);

    const datasets = series.map(s => ({
      label: s.label,
      data: s.data,
      borderColor: s.color,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: s.color,
      pointHoverBorderColor: '#fff',
      pointHoverBorderWidth: 2,
      tension: 0.3,
      spanGaps: false,
      fill: false,
    }));

    const ctx = document.getElementById('pmChart').getContext('2d');
    if (window._pmChart) window._pmChart.destroy();
    window._pmChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      plugins: [aqiBandsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, font: { family: 'Inter', size: 10.5 } } },
          tooltip: {
            backgroundColor: '#0F1B14',
            titleFont: { family: 'Space Grotesk', size: 11 },
            bodyFont: { family: 'Inter', size: 12 },
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => {
                const v = item.raw;
                return `${item.dataset.label}: ${isNum(v) ? v.toFixed(1) : '—'} µg/m³`;
              }
            }
          }
        },
        scales: {
          x: { display: true, grid: { display: false }, title: { display: true, text: xTitle, font: { size: 10.5 } }, ticks: { maxTicksLimit: 10, autoSkip: true, font: { size: 10 } } },
          y: {
            display: true,
            min: 0,
            max: CHART_Y_MAX,
            grid: { color: '#ECEAE1' },
            title: { display: true, text: 'PM2.5 (µg/m³)', font: { size: 10.5 } },
            ticks: { font: { size: 10 } }
          }
        },
        onHover: (event, elements) => { if (elements && elements.length > 0) moveSensorMarkerTo(elements[0].index); }
      }
    });
    document.getElementById('pmChart').addEventListener('mouseleave', hideSensorMarker);

    // KPI strip
    document.getElementById('kAvg').innerHTML = withUnit(readingMean.toFixed(1), 'µg/m³');
    document.getElementById('kPeak').innerHTML = withUnit(peak.toFixed(1), 'µg/m³');
    document.getElementById('kPeakSub').textContent = peakSensor;
    document.getElementById('kMin').innerHTML = withUnit(min.toFixed(1), 'µg/m³');
    document.getElementById('kMinSub').textContent = minSensor;
    document.getElementById('kSpread').innerHTML = withUnit(maxSpread.toFixed(1), 'µg/m³');

    const kWho = document.getElementById('kWho');
    kWho.textContent = cat.label;
    kWho.style.color = cat.text;
    kWho.style.fontSize = cat.label.length > 9 ? '15px' : '20px';
    document.getElementById('kWhoSub').textContent = `avg ${readingMean.toFixed(1)} µg/m³`;

    const avgSub = document.getElementById('kAvgSub');
    avgSub.textContent = cat.label;
    avgSub.style.color = cat.text;

    // Insight panel: category gauge
    document.getElementById('gaugeVal').textContent = `${readingMean.toFixed(1)} µg/m³ · ${cat.label}`;
    const scale = document.getElementById('gaugeScale');
    const segs = AQI_BANDS.filter(b => b.min < GAUGE_MAX).map(b => {
      const w = ((Math.min(b.max, GAUGE_MAX) - b.min) / GAUGE_MAX) * 100;
      return `<span class="g-seg" style="width:${w}%;background:${b.bar}" title="${b.label}"></span>`;
    }).join('');
    const pointerLeft = Math.min(readingMean, GAUGE_MAX) / GAUGE_MAX * 100;
    scale.innerHTML = segs + `<span class="g-pointer" style="left:${pointerLeft}%"></span>`;
    renderGaugeAxis();

    document.getElementById('mExceed').textContent = categoryMix(meanLine);
    document.getElementById('mSensors').textContent = `${series.length} × AirBeam 3`;
    document.getElementById('mPoints').textContent = totalReadings.toLocaleString() + (sourceNote ? ` ${sourceNote}` : '');
  }

  function categoryMix(values) {
    if (!values.length) return '—';
    const counts = {};
    values.forEach(v => { const l = aqiCategory(v).label; counts[l] = (counts[l] || 0) + 1; });
    return AQI_BANDS.map(b => b.label).filter(l => counts[l])
      .map(l => `${l.replace(' (SG)', '')} ${Math.round((counts[l] / values.length) * 100)}%`)
      .join(' · ');
  }

  function renderFromProfiles(sessions, primary) {
    const { labels, series, coordTrack, routePoints } = buildTimeSeries(sessions, primary);
    drawRoute(routePoints, primary.dist);
    setupHover(coordTrack);
    renderPM({
      labels, series,
      totalReadings: sessions.reduce((a, s) => a + s.count, 0),
      xTitle: 'Time of day', sourceNote: 'readings'
    });
  }

  // ---------- Loaders ----------
  async function loadAirbeam() {
    let stage = 'startup';
    try {
      if (location.protocol === 'file:') {
        throw new Error('Page opened via file:// — browsers block fetch() to local CSV files.');
      }
      if (typeof Chart === 'undefined') {
        throw new Error('Chart.js did not load. Check network access to cdn.jsdelivr.net.');
      }

      stage = 'fetch CSV files';
      const results = await Promise.all(AIRBEAM_FILES.map(async (path) => {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
        return { path, text: await res.text() };
      }));

      stage = 'parse sensor sessions';
      const sessions = [];
      const skipped = [];
      results.forEach(({ path, text }, i) => {
        const { rows, sensorId } = airbeamRowsFromText(text);
        if (rows.length < MIN_ROWS) {
          skipped.push(`${path.split('/').pop()} (${rows.length} rows, need ${MIN_ROWS}+)`);
          return;
        }
        const s = parseSession(rows);
        if (s) {
          s.id = shortId(path, sensorId ? sensorId.slice(-4) : String(i + 1));
          sessions.push(s);
        } else skipped.push(`${path.split('/').pop()} (could not parse GPS/PM2.5/time)`);
      });
      if (!sessions.length) {
        throw new Error(
          'No usable sensor sessions.\n' +
          `Skipped: ${skipped.join('; ') || 'none'}\n` +
          `Expected at least one file with ${MIN_ROWS}+ rows in data/`
        );
      }

      stage = 'render chart';
      const primary = sessions.reduce((a, b) => (b.count > a.count ? b : a));
      renderFromProfiles(sessions, primary);
    } catch (err) {
      console.error(`AirBeam load failed (${stage}):`, err);
      showLoadError('chartWrap', {
        title: 'AirBeam sensor data could not be loaded',
        stage,
        error: err,
        hints: loadHints(),
      });
    }
  }

  async function loadSpots() {
    let stage = 'startup';
    try {
      if (location.protocol === 'file:') {
        throw new Error('Page opened via file:// — browsers block fetch() to local CSV files.');
      }

      stage = 'fetch spots CSV';
      const res = await fetch(SPOTS_FILE);
      if (!res.ok) throw new Error(`${SPOTS_FILE} returned HTTP ${res.status}`);

      stage = 'parse observations';
      const spots = parseCSV(await res.text(), ';')
        .map(normalizeSpot)
        .filter(Boolean)
        .filter(spotInActivation);
      if (!spots.length) throw new Error('No valid observations found for this activation (check SPOTS_FILTER).');

      stage = 'render map markers';
      renderSpots(spots);
    } catch (err) {
      console.error(`Spots load failed (${stage}):`, err);
      showLoadError('issueBars', {
        title: 'Observation data could not be loaded',
        stage,
        error: err,
        hints: loadHints(),
      });
      document.getElementById('kObs').textContent = '—';
      document.getElementById('kObsSub').textContent = 'data unavailable';
    }
  }

  loadAirbeam();
  loadSpots();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { map.invalidateSize(); }, 150);
  });
})();
