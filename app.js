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

  // Real AirBeam 3 exports (one recording session per file).
  const AIRBEAM_FILES = [
    'data/data_AirBeam3_0cb815aa87e8.csv',
    'data/data_AirBeam3_94e686f652c8.csv',
    'data/data_AirBeam3_0cb815a920b8.csv',
    'data/data_AirBeam3_30cb815aa87e8.csv',
  ];
  // Real citizen observations ("spots") export from SpotterOn (semicolon-delimited).
  const SPOTS_FILE = 'data/urbanbetter_spots_20260707220128.csv';

  const MIN_ROWS = 300;   // drop partial/aborted sessions (e.g. the 87-row file)
  const BIN_MS = 60000;   // aggregate readings per minute of clock time

  // ---------- Map base ----------
  const map = L.map('map', { zoomControl: true, scrollWheelZoom: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(map);
  map.setView([6.5765, 3.392], 15);

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
  const shortId = file => { const m = file.match(/AirBeam3_([0-9a-f]+)\.csv/i); return m ? m[1].slice(-4) : ''; };

  const parseTime = s => { const t = Date.parse((s || '').replace(' ', 'T')); return isFinite(t) ? t : NaN; };
  const fmtHM = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
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
  // Single route line (the primary sensor's GPS track). Observations are separate point markers.
  function drawRoute(primaryTrack, distMeters) {
    L.polyline(primaryTrack, { color: '#7EC1F0', weight: 2, opacity: 0.95, lineJoin: 'round', smoothFactor: 2 }).addTo(map);

    L.circleMarker(primaryTrack[0], { radius: 6, color: '#123825', fillColor: '#C6E24E', fillOpacity: 1, weight: 2 })
      .addTo(map).bindTooltip('Start');
    L.circleMarker(primaryTrack[primaryTrack.length - 1], { radius: 6, color: '#123825', fillColor: '#123825', fillOpacity: 1, weight: 2 })
      .addTo(map).bindTooltip('Finish');

    map.fitBounds(L.latLngBounds(primaryTrack).pad(0.2));
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
          className: '', iconSize: null
        });
      }
    });
  }

  function makeSpotMarker(sp) {
    const icon = L.divIcon({ className: '', html: `<div class="feature-marker ${sp.type}"></div>`, iconSize: [16, 16] });
    const marker = L.marker([sp.lat, sp.lon], { icon, spotType: sp.type });
    const typeLabel = sp.type === 'negative' ? 'Negative observation'
      : sp.type === 'positive' ? 'Positive observation' : 'Observation (untagged)';
    marker.bindPopup(`
      <div class="popup-card">
        ${sp.image ? `<img src="${sp.image}" alt="observation" onerror="this.style.display='none'"/>` : ''}
        <div class="ptype ${sp.type}">${typeLabel}</div>
        ${sp.posTags.length ? `<div class="plabel" style="color:var(--green)">+ ${escapeHtml(sp.posTags.join(', '))}</div>` : ''}
        ${sp.negTags.length ? `<div class="plabel" style="color:var(--coral-deep)">− ${escapeHtml(sp.negTags.join(', '))}</div>` : ''}
        ${sp.desc ? `<div class="pnote">${escapeHtml(sp.desc)}</div>` : ''}
        ${sp.time ? `<div class="pnote" style="margin-top:4px;opacity:.65">${escapeHtml(sp.time)}</div>` : ''}
      </div>
    `);
    return marker;
  }

  function applyCategoryFilter() {
    if (!spotClusterGroup) return;
    spotClusterGroup.clearLayers();
    allSpots.filter(spotMatchesFilter).forEach(sp => spotClusterGroup.addLayer(makeSpotMarker(sp)));
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
    document.getElementById('kObsSub').textContent = `${posN} positive · ${negN} negative · ${neuN} neutral`;

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
      if (isFinite(lat) && isFinite(lon) && isFinite(pm) && isFinite(t)) pts.push({ t, lat, lon, pm });
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

  // Nearest-neighbour fill for the per-minute coordinate track (hover marker).
  function fillCoordNulls(a) {
    const first = a.findIndex(x => x);
    if (first < 0) return;
    for (let i = 0; i < first; i++) a[i] = a[first];
    let last = first;
    for (let i = first + 1; i < a.length; i++) { if (a[i]) last = i; else a[i] = a[last]; }
  }

  // Aggregate every session onto a shared clock-time (per-minute) axis.
  function buildTimeSeries(sessions, primary) {
    let start = Infinity, end = -Infinity;
    sessions.forEach(s => { for (const p of s.pts) { if (p.t < start) start = p.t; if (p.t > end) end = p.t; } });
    const nBins = Math.max(1, Math.floor((end - start) / BIN_MS) + 1);
    const labels = [];
    for (let b = 0; b < nBins; b++) labels.push(fmtHM(start + b * BIN_MS));

    const binOf = t => Math.max(0, Math.min(nBins - 1, Math.floor((t - start) / BIN_MS)));

    const series = sessions.map((s, i) => {
      const sums = new Array(nBins).fill(0), counts = new Array(nBins).fill(0);
      for (const p of s.pts) { const b = binOf(p.t); sums[b] += p.pm; counts[b]++; }
      const data = new Array(nBins).fill(null);
      for (let b = 0; b < nBins; b++) if (counts[b]) data[b] = +(sums[b] / counts[b]).toFixed(1);
      return { label: 'AirBeam ' + (s.id || (i + 1)), data, color: SENSOR_COLORS[i % SENSOR_COLORS.length] };
    });

    // Primary sensor's average coordinate per minute — used for the hover ping.
    const latS = new Array(nBins).fill(0), lonS = new Array(nBins).fill(0), cc = new Array(nBins).fill(0);
    for (const p of primary.pts) { const b = binOf(p.t); latS[b] += p.lat; lonS[b] += p.lon; cc[b]++; }
    const coordTrack = new Array(nBins).fill(null);
    for (let b = 0; b < nBins; b++) if (cc[b]) coordTrack[b] = [latS[b] / cc[b], lonS[b] / cc[b]];
    fillCoordNulls(coordTrack);

    return { labels, series, coordTrack };
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
  // series: [{ label, data:[per-bin values, may contain null], color }]
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
          y: { display: true, beginAtZero: true, grid: { color: '#ECEAE1' }, title: { display: true, text: 'PM2.5 (µg/m³)', font: { size: 10.5 } }, ticks: { font: { size: 10 } } }
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
    const { labels, series, coordTrack } = buildTimeSeries(sessions, primary);
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
        const rows = parseCSV(text, ',');
        if (rows.length < MIN_ROWS) {
          skipped.push(`${path.split('/').pop()} (${rows.length} rows, need ${MIN_ROWS}+)`);
          return;
        }
        const s = parseSession(rows);
        if (s) { s.id = shortId(AIRBEAM_FILES[i]); sessions.push(s); }
        else skipped.push(`${path.split('/').pop()} (could not parse GPS/PM2.5/time)`);
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
      drawRoute(downsample(primary.track, 400), primary.dist);
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
      const spots = parseCSV(await res.text(), ';').map(normalizeSpot).filter(Boolean);
      if (!spots.length) throw new Error('No valid observations found in spots CSV.');

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
})();
