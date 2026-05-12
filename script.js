// ══════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════
const state = {
  depot: null,         // { name, lat, lng, marker }
  addresses: [],       // [{ id, name, lat, lng, marker, color, serviceTime }]
  routes: [],          // [{ addressId, polyline, distance, duration, geometry }]
  distanceMatrix: null, // { distances: [][], durations: [][], names: [] }
  tspRoute: null,      // [index, ...]
  tspPolyline: null,
  vrpResult: null,     // { routes: [[index, ...], ...], vehicles: number, totalDist, totalTime }
  vrpPolylines: [],    // polylines for VRP routes
  nextId: 1,
};

// ══════════════════════════════════════════════════
// COLORS
// ══════════════════════════════════════════════════
const ROUTE_COLORS = [
  '#00ff88','#00aaff','#ff66cc','#ffaa00','#aa66ff',
  '#ff6644','#44ffcc','#ffff44','#ff44aa','#88ff44',
  '#44aaff','#ffcc44','#cc44ff','#44ffaa','#ff8844',
];

function getColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

// ══════════════════════════════════════════════════
// MAP INIT
// ══════════════════════════════════════════════════
const map = L.map('map', {
  center: [28.0, 2.5],
  zoom: 6,
  zoomControl: true,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 20,
  subdomains: 'abcd',
}).addTo(map);

// ══════════════════════════════════════════════════
// STATUS
// ══════════════════════════════════════════════════
const statusEl = document.getElementById('status');

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

// ══════════════════════════════════════════════════
// NOMINATIM GEOCODING + AUTOCOMPLETE
// ══════════════════════════════════════════════════
let lastNominatimCall = 0;
const NOMINATIM_DELAY = 1100; // >1s to respect usage policy

async function nominatimSearch(query) {
  const now = Date.now();
  const wait = NOMINATIM_DELAY - (now - lastNominatimCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimCall = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=dz&limit=5&addressdetails=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RouteVisualizerDZ/1.0' }
  });
  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
  return res.json();
}

function setupAutocomplete(inputId, listId, onSelect) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let debounceTimer = null;
  let selectedData = null;

  input.addEventListener('input', () => {
    selectedData = null;
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { list.classList.remove('active'); return; }

    debounceTimer = setTimeout(async () => {
      try {
        const results = await nominatimSearch(q);
        list.innerHTML = '';
        if (results.length === 0) {
          list.classList.remove('active');
          return;
        }
        results.forEach(r => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          item.textContent = r.display_name;
          item.addEventListener('click', () => {
            input.value = r.display_name.split(',')[0].trim();
            selectedData = { name: r.display_name.split(',')[0].trim(), lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
            list.classList.remove('active');
          });
          list.appendChild(item);
        });
        list.classList.add('active');
      } catch (e) {
        console.error('Autocomplete error:', e);
      }
    }, 300);
  });

  // Close list on outside click
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.classList.remove('active');
    }
  });

  return {
    getSelected: () => selectedData,
    setSelected: (d) => { selectedData = d; },
    clear: () => { input.value = ''; selectedData = null; list.classList.remove('active'); },
    getInput: () => input,
  };
}

const depotAC = setupAutocomplete('depot-input', 'depot-autocomplete');
const addressAC = setupAutocomplete('address-input', 'address-autocomplete');

// ══════════════════════════════════════════════════
// MARKER CREATION
// ══════════════════════════════════════════════════
function createMarkerIcon(color, size = 14) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:${size}px;height:${size}px;box-shadow:0 0 8px ${color}66;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
  });
}

function addDepotMarker(lat, lng, name) {
  const marker = L.marker([lat, lng], {
    icon: createMarkerIcon('#ff4444', 18),
    draggable: true,
    zIndexOffset: 1000,
  }).addTo(map);

  marker.bindPopup(`<b>DEPOT</b><br>${name}`);

  marker.on('dragend', () => {
    const pos = marker.getLatLng();
    state.depot.lat = pos.lat;
    state.depot.lng = pos.lng;
    clearRoutes();
  });

  return marker;
}

function addAddressMarker(lat, lng, name, color, pickupTime) {
  const marker = L.marker([lat, lng], {
    icon: createMarkerIcon(color, 14),
    draggable: true,
  }).addTo(map);

  const timeDisplay = pickupTime ? `<br>Ramassage: <b>${pickupTime}</b>` : '';
  marker.bindPopup(`<b>${name}</b>${timeDisplay}`);

  marker.on('dragend', () => {
    const pos = marker.getLatLng();
    const addr = state.addresses.find(a => a.marker === marker);
    if (addr) {
      addr.lat = pos.lat;
      addr.lng = pos.lng;
      clearRoutes();
    }
  });

  return marker;
}

// ══════════════════════════════════════════════════
// DEPOT MANAGEMENT
// ══════════════════════════════════════════════════
const depotDisplay = document.getElementById('depot-display');
const depotNameText = document.getElementById('depot-name-text');

function setDepot(data) {
  // Remove previous
  if (state.depot && state.depot.marker) {
    map.removeLayer(state.depot.marker);
  }
  clearRoutes();

  const marker = addDepotMarker(data.lat, data.lng, data.name);
  state.depot = { name: data.name, lat: data.lat, lng: data.lng, marker };

  depotNameText.textContent = data.name;
  depotDisplay.style.display = 'flex';

  map.setView([data.lat, data.lng], 10);
  setStatus(`Dépôt fixé : ${data.name}`, 'success');
}

function removeDepot() {
  if (state.depot) {
    if (state.depot.marker) map.removeLayer(state.depot.marker);
    state.depot = null;
  }
  depotDisplay.style.display = 'none';
  clearRoutes();
  setStatus('Dépôt supprimé.', '');
}

document.getElementById('btn-set-depot').addEventListener('click', async () => {
  const sel = depotAC.getSelected();
  if (sel) {
    setDepot(sel);
    depotAC.clear();
    return;
  }
  // If typed but not selected from list, do a search
  const q = document.getElementById('depot-input').value.trim();
  if (!q) return;
  try {
    setStatus('Recherche du dépôt...', 'loading');
    const results = await nominatimSearch(q);
    if (results.length === 0) {
      setStatus('Aucun résultat pour le dépôt.', 'error');
      return;
    }
    const r = results[0];
    setDepot({ name: r.display_name.split(',')[0].trim(), lat: parseFloat(r.lat), lng: parseFloat(r.lon) });
    depotAC.clear();
  } catch (e) {
    setStatus(`Erreur géocodage: ${e.message}`, 'error');
  }
});

document.getElementById('btn-remove-depot').addEventListener('click', removeDepot);

// ══════════════════════════════════════════════════
// ADDRESS MANAGEMENT
// ══════════════════════════════════════════════════
const addressListEl = document.getElementById('address-list');

function renderAddressList() {
  addressListEl.innerHTML = '';
  state.addresses.forEach(addr => {
    const div = document.createElement('div');
    div.className = 'address-item';
    const timeDisplay = addr.pickupTime !== undefined ? ` <span style="color:var(--orange);font-size:0.75rem;">${addr.pickupTime}</span>` : '';
    div.innerHTML = `
      <span class="addr-color" style="background:${addr.color}"></span>
      <span class="addr-name" title="${addr.name}">${addr.name}${timeDisplay}</span>
      <button class="btn-remove" data-id="${addr.id}" title="Supprimer">&times;</button>
    `;
    div.querySelector('.btn-remove').addEventListener('click', () => removeAddress(addr.id));
    addressListEl.appendChild(div);
  });
  updatePickupTimeNodeList();
  updatePickupTimeDisplay();
}

function addAddress(data) {
  const id = state.nextId++;
  const color = getColor(state.addresses.length);
  const marker = addAddressMarker(data.lat, data.lng, data.name, color);

  state.addresses.push({ id, name: data.name, lat: data.lat, lng: data.lng, marker, color, pickupTime: undefined });
  renderAddressList();
  fitBounds();
  setStatus(`Adresse ajoutée : ${data.name}`, 'success');
}

function removeAddress(id) {
  const idx = state.addresses.findIndex(a => a.id === id);
  if (idx === -1) return;
  const addr = state.addresses[idx];
  if (addr.marker) map.removeLayer(addr.marker);

  // Remove associated route
  const routeIdx = state.routes.findIndex(r => r.addressId === id);
  if (routeIdx !== -1) {
    if (state.routes[routeIdx].polyline) map.removeLayer(state.routes[routeIdx].polyline);
    state.routes.splice(routeIdx, 1);
  }

  state.addresses.splice(idx, 1);
  renderAddressList();
  setStatus(`Adresse supprimée : ${addr.name}`, '');
}

function updateMarkerPopup(addr) {
  const timeDisplay = addr.pickupTime ? `<br>Ramassage: <b>${addr.pickupTime}</b>` : '';
  addr.marker.setPopupContent(`<b>${addr.name}</b>${timeDisplay}`);
}

function updateServiceTimeNodeList() {
  const select = document.getElementById('service-time-node');
  select.innerHTML = '<option value="">Sélectionner un nœud...</option>';
  state.addresses.forEach(addr => {
    const option = document.createElement('option');
    option.value = addr.id;
    const timeStr = addr.pickupTime !== undefined ? ` (${addr.pickupTime})` : '';
    option.textContent = `${addr.name}${timeStr}`;
    select.appendChild(option);
  });
}

function updatePickupTimeDisplay() {
  const list = document.getElementById('pickup-time-list');
  const nodesWithTime = state.addresses.filter(a => a.pickupTime !== undefined);
  if (nodesWithTime.length === 0) {
    list.textContent = 'Aucune heure définie.';
  } else {
    list.innerHTML = nodesWithTime.map(a => 
      `<span style="color:var(--accent);font-weight:600;">${a.name}</span>: ${a.pickupTime}`
    ).join(' · ');
  }
}

function updatePickupTimeNodeList() {
  const select = document.getElementById('pickup-time-node');
  select.innerHTML = '<option value="">Sélectionner un nœud...</option>';
  state.addresses.forEach(addr => {
    const option = document.createElement('option');
    option.value = addr.id;
    const timeStr = addr.pickupTime !== undefined ? ` (${addr.pickupTime})` : '';
    option.textContent = `${addr.name}${timeStr}`;
    select.appendChild(option);
  });
}

document.getElementById('btn-set-pickup-time').addEventListener('click', () => {
  const select = document.getElementById('pickup-time-node');
  const timeInput = document.getElementById('pickup-time-input');
  const nodeId = parseInt(select.value);
  const timeStr = timeInput.value.trim();

  if (!nodeId) {
    setStatus('Sélectionnez un nœud.', 'error');
    return;
  }
  if (!timeStr) {
    setStatus('Entrez une heure (ex: 10:30).', 'error');
    return;
  }

  if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
    setStatus('Format invalide. Utilisez HH:MM.', 'error');
    return;
  }

  const addr = state.addresses.find(a => a.id === nodeId);
  if (addr) {
    addr.pickupTime = timeStr;
    updateMarkerPopup(addr);
    renderAddressList();
    setStatus(`Heure: ${addr.name} = ${timeStr}`, 'success');
    timeInput.value = '';
  }
});

document.getElementById('btn-add-address').addEventListener('click', async () => {
  const sel = addressAC.getSelected();
  if (sel) {
    addAddress(sel);
    addressAC.clear();
    return;
  }
  const q = document.getElementById('address-input').value.trim();
  if (!q) return;
  try {
    setStatus('Recherche de l\'adresse...', 'loading');
    const results = await nominatimSearch(q);
    if (results.length === 0) {
      setStatus('Aucun résultat.', 'error');
      return;
    }
    const r = results[0];
    addAddress({ name: r.display_name.split(',')[0].trim(), lat: parseFloat(r.lat), lng: parseFloat(r.lon) });
    addressAC.clear();
  } catch (e) {
    setStatus(`Erreur géocodage: ${e.message}`, 'error');
  }
});

// Enter key support
document.getElementById('depot-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-set-depot').click();
});
document.getElementById('address-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-add-address').click();
});

// ══════════════════════════════════════════════════
// FIT BOUNDS
// ══════════════════════════════════════════════════
function fitBounds() {
  const points = [];
  if (state.depot) points.push([state.depot.lat, state.depot.lng]);
  state.addresses.forEach(a => points.push([a.lat, a.lng]));
  if (points.length >= 2) {
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }
}

// ══════════════════════════════════════════════════
// OSRM ROUTING
// ══════════════════════════════════════════════════
let lastOsrmCall = 0;
const OSRM_DELAY = 1100;

async function osrmRoute(lng1, lat1, lng2, lat2) {
  const now = Date.now();
  const wait = OSRM_DELAY - (now - lastOsrmCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastOsrmCall = Date.now();

  const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM error: ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error(`OSRM: ${data.code}`);
  return data.routes[0];
}

async function osrmTable(coords) {
  const now = Date.now();
  const wait = OSRM_DELAY - (now - lastOsrmCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastOsrmCall = Date.now();

  const coordStr = coords.map(c => `${c[1]},${c[0]}`).join(';'); // lng,lat
  const url = `https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=distance,duration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM table error: ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error(`OSRM table: ${data.code}`);
  return data;
}

// ══════════════════════════════════════════════════
// CLEAR ROUTES
// ══════════════════════════════════════════════════
function clearRoutes() {
  state.routes.forEach(r => {
    if (r.polyline) map.removeLayer(r.polyline);
  });
  state.routes = [];
  if (state.tspPolyline) {
    map.removeLayer(state.tspPolyline);
    state.tspPolyline = null;
  }
  // Clear VRP polylines
  state.vrpPolylines.forEach(p => map.removeLayer(p));
  state.vrpPolylines = [];
  state.vrpResult = null;
  state.distanceMatrix = null;
  state.tspRoute = null;
  document.getElementById('matrix-section').style.display = 'none';
  document.getElementById('matrix-overlay').classList.remove('active');
  document.getElementById('tsp-result').style.display = 'none';
  document.getElementById('vrp-result-section').style.display = 'none';
}

// ══════════════════════════════════════════════════
// CALCULATE ALL ROUTES
// ══════════════════════════════════════════════════
document.getElementById('btn-calculate').addEventListener('click', async () => {
  if (!state.depot) { setStatus('Fixez d\'abord un dépôt.', 'error'); return; }
  if (state.addresses.length === 0) { setStatus('Ajoutez au moins une adresse.', 'error'); return; }

  clearRoutes();

  const total = state.addresses.length;
  for (let i = 0; i < total; i++) {
    const addr = state.addresses[i];
    setStatus(`Calcul itinéraire ${i + 1}/${total} : ${addr.name}...`, 'loading');

    try {
      const route = await osrmRoute(state.depot.lng, state.depot.lat, addr.lng, addr.lat);
      const coords = route.geometry.coordinates.map(c => [c[1], c[0]]); // [lat, lng]

      const polyline = L.polyline(coords, {
        color: addr.color,
        weight: 3,
        opacity: 0.8,
      }).addTo(map);

      const distKm = (route.distance / 1000).toFixed(1);
      const durMin = Math.round(route.duration / 60);
      polyline.bindPopup(`<b>${addr.name}</b><br>${distKm} km — ${durMin} min`);

      // Update marker popup
      addr.marker.setPopupContent(`<b>${addr.name}</b><br>${distKm} km — ${durMin} min`);

      state.routes.push({
        addressId: addr.id,
        polyline,
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry,
      });
    } catch (e) {
      setStatus(`Erreur route vers ${addr.name}: ${e.message}`, 'error');
      console.error(e);
    }
  }

  // Calculate distance matrix
  setStatus('Calcul de la matrice de distances...', 'loading');
  try {
    const allPoints = [
      { name: 'DEPOT', lat: state.depot.lat, lng: state.depot.lng },
      ...state.addresses.map(a => ({ name: a.name, lat: a.lat, lng: a.lng })),
    ];
    const coords = allPoints.map(p => [p.lat, p.lng]);
    const table = await osrmTable(coords);

    state.distanceMatrix = {
      distances: table.distances,
      durations: table.durations,
      names: allPoints.map(p => p.name),
    };

    renderDistanceTable();
    setStatus(`${total} itinéraires calculés + matrice.`, 'success');
  } catch (e) {
    setStatus(`Itinéraires OK, erreur matrice: ${e.message}`, 'error');
    console.error(e);
  }

  fitBounds();
});

// ══════════════════════════════════════════════════
// DISTANCE TABLE RENDERING
// ══════════════════════════════════════════════════
function renderDistanceTable() {
  if (!state.distanceMatrix) return;

  const { distances, durations, names } = state.distanceMatrix;
  const table = document.getElementById('distance-table');

  let html = '<thead><tr><th>↕ Nœud</th>';
  names.forEach(n => { html += `<th title="${n}">${abbreviate(n)}</th>`; });
  html += '</tr></thead><tbody>';

  for (let i = 0; i < names.length; i++) {
    html += `<tr><td title="${names[i]}">${abbreviate(names[i])}</td>`;
    for (let j = 0; j < names.length; j++) {
      if (i === j) {
        html += '<td class="diagonal">—</td>';
      } else {
        const km = (distances[i][j] / 1000).toFixed(0);
        const min = Math.round(durations[i][j] / 60);
        html += `<td title="${names[i]} → ${names[j]}: ${km} km, ${min} min">
          <span style="color:var(--accent);font-weight:600;">${km}</span>
          <br><span style="color:var(--orange);font-size:0.68rem;font-weight:500;">${min}m</span>
        </td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  // Show the matrix section button
  document.getElementById('matrix-section').style.display = 'block';
}

function abbreviate(name) {
  if (name.length <= 7) return name;
  return name.substring(0, 6) + '.';
}

// Matrix modal controls
document.getElementById('btn-show-matrix').addEventListener('click', () => {
  document.getElementById('matrix-overlay').classList.add('active');
});

document.getElementById('matrix-close').addEventListener('click', () => {
  document.getElementById('matrix-overlay').classList.remove('active');
});

document.getElementById('matrix-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('matrix-overlay')) {
    document.getElementById('matrix-overlay').classList.remove('active');
  }
});

// Close with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('matrix-overlay').classList.remove('active');
    document.getElementById('graph-overlay').classList.remove('active');
  }
});

// ══════════════════════════════════════════════════
// TSP — NEAREST NEIGHBOR
// ══════════════════════════════════════════════════
document.getElementById('btn-tsp').addEventListener('click', async () => {
  if (!state.distanceMatrix) {
    setStatus('Calculez d\'abord les itinéraires.', 'error');
    return;
  }

  const n = state.distanceMatrix.names.length;
  const dist = state.distanceMatrix.distances;

  // Nearest neighbor starting from depot (index 0)
  const visited = new Set([0]);
  const order = [0];
  let current = 0;

  while (visited.size < n) {
    let nearest = -1;
    let nearestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited.has(j) && dist[current][j] < nearestDist) {
        nearest = j;
        nearestDist = dist[current][j];
      }
    }
    visited.add(nearest);
    order.push(nearest);
    current = nearest;
  }
  order.push(0); // return to depot

  state.tspRoute = order;

  // Display result
  const names = state.distanceMatrix.names;
  const orderEl = document.getElementById('tsp-order');
  orderEl.innerHTML = order.map((idx, i) => {
    const arrow = i < order.length - 1 ? ' → ' : '';
    const pickupInfo = idx > 0 && state.addresses[idx - 1] && state.addresses[idx - 1].pickupTime 
      ? ` <span style="color:#ffaa00;">[${state.addresses[idx - 1].pickupTime}]</span>` : '';
    return `<span style="color:${idx === 0 ? '#ff4444' : '#00ff88'}">${names[idx]}${pickupInfo}</span>${arrow}`;
  }).join('');

  let totalDist = 0;
  let totalDur = 0;
  for (let i = 0; i < order.length - 1; i++) {
    totalDist += dist[order[i]][order[i + 1]];
    totalDur += state.distanceMatrix.durations[order[i]][order[i + 1]];
  }
  const totalMin = Math.round(totalDur / 60);
  document.getElementById('tsp-total').textContent =
    `Total : ${(totalDist / 1000).toFixed(1)} km — ${totalMin} min`;
  document.getElementById('tsp-result').style.display = 'block';

  // Draw TSP route on map
  if (state.tspPolyline) {
    map.removeLayer(state.tspPolyline);
  }

  setStatus('Tracé de la tournée optimisée...', 'loading');
  const tspCoords = [];
  for (let i = 0; i < order.length - 1; i++) {
    const fromIdx = order[i];
    const toIdx = order[i + 1];
    const allPoints = [state.depot, ...state.addresses];
    const from = allPoints[fromIdx];
    const to = allPoints[toIdx];

    try {
      const route = await osrmRoute(from.lng, from.lat, to.lng, to.lat);
      const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
      tspCoords.push(...coords);
    } catch (e) {
      // Fallback: straight line
      tspCoords.push([from.lat, from.lng], [to.lat, to.lng]);
    }
  }

  state.tspPolyline = L.polyline(tspCoords, {
    color: '#ffaa00',
    weight: 4,
    opacity: 0.9,
    dashArray: '10, 8',
  }).addTo(map);

  setStatus('Tournée optimisée calculée.', 'success');
});

// ══════════════════════════════════════════════════
// VRP WITH TIME WINDOWS
// ══════════════════════════════════════════════════
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

document.getElementById('btn-vrp').addEventListener('click', async () => {
  if (!state.distanceMatrix) {
    setStatus('Calculez d\'abord les itinéraires.', 'error');
    return;
  }
  if (state.addresses.length === 0) {
    setStatus('Ajoutez au moins une adresse.', 'error');
    return;
  }

  setStatus('Résolution VRP...', 'loading');

  const maxVehicles = parseInt(document.getElementById('vrp-vehicles').value) || 5;
  const twStart = timeToMinutes(document.getElementById('vrp-tw-start').value || '08:00');
  const twEnd = timeToMinutes(document.getElementById('vrp-tw-end').value || '18:00');

  const n = state.addresses.length;
  const dist = state.distanceMatrix.distances;
  const dur = state.distanceMatrix.durations;

  // Sort clients by pickup time
  const clientsWithTime = state.addresses.map((a, i) => ({...a, idx: i}))
    .filter(a => a.pickupTime)
    .map(a => ({...a, minutes: timeToMinutes(a.pickupTime)}))
    .sort((a, b) => a.minutes - b.minutes);

  // Sort unassigned by pickup time
  const unassigned = clientsWithTime.map(a => a.idx);
  state.addresses.forEach((a, i) => {
    if (!a.pickupTime && !unassigned.includes(i)) unassigned.push(i);
  });

  const routes = [];
  let vehicleCount = 0;

  // Simple route construction: visit clients in order of pickup time
  while (unassigned.length > 0 && vehicleCount < maxVehicles) {
    vehicleCount++;
    const currentRoute = [];
    let currentTime = twStart;

    while (unassigned.length > 0) {
      let bestIdx = -1;
      let bestScore = Infinity;

      for (let i = 0; i < unassigned.length; i++) {
        const client = unassigned[i];
        const lastNode = currentRoute.length === 0 ? 0 : currentRoute[currentRoute.length - 1] + 1;
        const travelTime = dur[lastNode][client + 1] / 60;
        const arrivalTime = currentTime + travelTime;
        
        let score = travelTime;
        if (state.addresses[client].pickupTime) {
          const pickupMinutes = timeToMinutes(state.addresses[client].pickupTime);
          score += Math.abs(arrivalTime - pickupMinutes);
        }
        
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) break;

      const client = unassigned[bestIdx];
      const lastNode = currentRoute.length === 0 ? 0 : currentRoute[currentRoute.length - 1] + 1;
      const travelTime = dur[lastNode][client + 1] / 60;
      currentTime += travelTime;
      currentRoute.push(client);
      unassigned.splice(bestIdx, 1);
    }

    if (currentRoute.length > 0) {
      routes.push(currentRoute);
    }
  }

  // If still unassigned clients, they couldn't be routed
  if (unassigned.length > 0) {
    setStatus(`Attention: ${unassigned.length} clients non servis!`, 'error');
  }

  // Store VRP result
  state.vrpResult = {
    routes: routes,
    vehicles: vehicleCount,
    totalDist: 0,
    totalTime: 0
  };

  // Calculate total distance and time
  routes.forEach(route => {
    let prev = 0; // Depot
    route.forEach(client => {
      state.vrpResult.totalDist += dist[prev][client + 1];
      state.vrpResult.totalTime += dur[prev][client + 1] / 60;
      prev = client + 1;
    });
    // Return to depot
    state.vrpResult.totalDist += dist[prev][0];
    state.vrpResult.totalTime += dur[prev][0] / 60;
  });

  // Display results
  displayVRPResults();

  // Draw VRP routes on map
  await drawVRPRoutes();

  setStatus(`VRP résolu: ${vehicleCount} véhicule(s) utilisé(s)`, 'success');
});

function displayVRPResults() {
  const section = document.getElementById('vrp-result-section');
  const container = document.getElementById('vrp-result');
  
  if (!state.vrpResult || state.vrpResult.routes.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  const names = state.distanceMatrix.names;

  let html = `<div style="margin-bottom:8px;color:var(--orange);font-weight:700;font-size:0.85rem;">${state.vrpResult.vehicles} véhicule(s) utilisé(s)</div>`;
  
  state.vrpResult.routes.forEach((route, vIdx) => {
    const color = getColor(vIdx);
    html += `<div style="margin:6px 0;padding:8px 10px;background:var(--surface2);border-left:3px solid ${color};border-radius:0 6px 6px 0;">`;
    html += `<div style="color:${color};font-weight:700;font-size:0.8rem;">Véhicule ${vIdx + 1}</div>`;
    
    let routeStr = `${names[0]} → `;
    route.forEach(clientIdx => {
      const addr = state.addresses[clientIdx];
      const pickup = addr.pickupTime || '?';
      routeStr += `${addr.name}[${pickup}] → `;
    });
    routeStr += names[0];
    
    html += `<div style="font-size:0.75rem;color:var(--text2);margin-top:4px;word-break:break-all;line-height:1.5;">${routeStr}</div>`;
    html += `</div>`;
  });

  const totalKm = (state.vrpResult.totalDist / 1000).toFixed(1);
  const totalMin = Math.round(state.vrpResult.totalTime);
  html += `<div style="margin-top:10px;color:var(--green);font-weight:700;font-size:0.85rem;">✓ Total: ${totalKm} km — ${totalMin} min</div>`;

  container.innerHTML = html;
}

async function drawVRPRoutes() {
  // Clear existing VRP polylines
  state.vrpPolylines.forEach(p => map.removeLayer(p));
  state.vrpPolylines = [];

  if (!state.vrpResult) return;

  for (let vIdx = 0; vIdx < state.vrpResult.routes.length; vIdx++) {
    const route = state.vrpResult.routes[vIdx];
    const color = getColor(vIdx);
    const allPoints = [state.depot, ...state.addresses];
    
    const coords = [];
    
    // Start from depot
    coords.push([state.depot.lat, state.depot.lng]);
    
    route.forEach(clientIdx => {
      const addr = state.addresses[clientIdx];
      coords.push([addr.lat, addr.lng]);
    });
    
    // Return to depot
    coords.push([state.depot.lat, state.depot.lng]);

    // Draw segments
    for (let i = 0; i < coords.length - 1; i++) {
      try {
        const routeData = await osrmRoute(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
        const segCoords = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
        
        const polyline = L.polyline(segCoords, {
          color: color,
          weight: 4,
          opacity: 0.85,
        }).addTo(map);

        state.vrpPolylines.push(polyline);
      } catch (e) {
        // Fallback: straight line
        const polyline = L.polyline([coords[i], coords[i + 1]], {
          color: color,
          weight: 4,
          opacity: 0.85,
          dashArray: '5, 5',
        }).addTo(map);
        state.vrpPolylines.push(polyline);
      }
    }
  }

  fitBounds();
}

// ══════════════════════════════════════════════════
// GRAPH — CANVAS FORCE-DIRECTED
// ══════════════════════════════════════════════════
document.getElementById('btn-graph').addEventListener('click', () => {
  if (!state.distanceMatrix) {
    setStatus('Calculez d\'abord les itinéraires.', 'error');
    return;
  }
  openGraph();
});

document.getElementById('graph-close').addEventListener('click', closeGraph);

function openGraph() {
  const overlay = document.getElementById('graph-overlay');
  overlay.classList.add('active');
  drawGraph();
}

function closeGraph() {
  const overlay = document.getElementById('graph-overlay');
  overlay.classList.remove('active');
}

// Close graph on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGraph();
});

function drawGraph() {
  const canvas = document.getElementById('graph-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const W = Math.min(window.innerWidth - 60, 1200);
  const H = Math.min(window.innerHeight - 60, 800);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const { distances, durations, names } = state.distanceMatrix;
  const n = names.length;

  // Build nodes — depot at center, others around
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) * 0.35;

  const nodes = [];
  // Depot at center
  nodes.push({ x: cx, y: cy, name: names[0], isDepot: true, vx: 0, vy: 0, pickupTime: null });

  // Others in a circle
  for (let i = 1; i < n; i++) {
    const angle = ((i - 1) / (n - 1)) * Math.PI * 2 - Math.PI / 2;
    const addr = state.addresses[i - 1];
    nodes.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      name: names[i],
      isDepot: false,
      vx: 0,
      vy: 0,
      pickupTime: addr ? addr.pickupTime : null,
    });
  }

  // Build edges (all pairs, but we'll only draw from depot for clarity, and between all)
  const edges = [];
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distances[i][j];
      if (d > maxDist) maxDist = d;
      edges.push({ from: i, to: j, distance: d, duration: durations[i][j] });
    }
  }

  // Force-directed simulation (simple)
  const iterations = 100;
  const kRepulse = 8000;
  const kAttract = 0.0001;
  const damping = 0.9;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion between all nodes
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = kRepulse / (dist * dist);
        let fx = (dx / dist) * force;
        let fy = (dy / dist) * force;
        if (!nodes[i].isDepot) { nodes[i].vx += fx; nodes[i].vy += fy; }
        if (!nodes[j].isDepot) { nodes[j].vx -= fx; nodes[j].vy -= fy; }
      }
    }

    // Attraction along edges
    edges.forEach(e => {
      let dx = nodes[e.to].x - nodes[e.from].x;
      let dy = nodes[e.to].y - nodes[e.from].y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = dist * kAttract;
      let fx = (dx / dist) * force;
      let fy = (dy / dist) * force;
      if (!nodes[e.from].isDepot) { nodes[e.from].vx += fx; nodes[e.from].vy += fy; }
      if (!nodes[e.to].isDepot) { nodes[e.to].vx -= fx; nodes[e.to].vy -= fy; }
    });

    // Center gravity
    for (let i = 0; i < n; i++) {
      if (nodes[i].isDepot) continue;
      nodes[i].vx += (cx - nodes[i].x) * 0.001;
      nodes[i].vy += (cy - nodes[i].y) * 0.001;
    }

    // Update positions
    for (let i = 0; i < n; i++) {
      if (nodes[i].isDepot) continue;
      nodes[i].vx *= damping;
      nodes[i].vy *= damping;
      nodes[i].x += nodes[i].vx;
      nodes[i].y += nodes[i].vy;
      // Bound
      nodes[i].x = Math.max(60, Math.min(W - 60, nodes[i].x));
      nodes[i].y = Math.max(60, Math.min(H - 60, nodes[i].y));
    }
  }

  // ── Pan / Zoom state ──
  let panX = 0, panY = 0, zoom = 1;
  let isPanning = false, panStartX = 0, panStartY = 0;

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Draw edges
    // Only draw edges involving depot for cleaner graph (show all if few nodes)
    const showAll = n <= 6;
    edges.forEach(e => {
      if (!showAll && e.from !== 0 && e.to !== 0) return;
      const a = nodes[e.from];
      const b = nodes[e.to];

      // Color based on distance
      const ratio = Math.min(e.distance / maxDist, 1);
      const color = distanceColor(ratio);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 3 - ratio * 2);
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Label at midpoint
      const mx = (a.x + b.x) / 2;
      const my = (a.x + b.y) / 2 - 2; // intentionally use a.x for slight offset
      const midY = (a.y + b.y) / 2 - 6;
      const km = (e.distance / 1000).toFixed(0);
      const min = Math.round(e.duration / 60);

      ctx.font = '10px monospace';
      ctx.fillStyle = '#aaa';
      ctx.textAlign = 'center';
      ctx.fillText(`${km}km`, (a.x + b.x) / 2, midY);
      ctx.fillStyle = '#777';
      ctx.fillText(`${min}min`, (a.x + b.x) / 2, midY + 13);
    });

    // Draw nodes
    nodes.forEach((node, i) => {
      const r = node.isDepot ? 20 : 14;
      const color = node.isDepot ? '#ff4444' : getColor(i - 1);

      // Glow
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = color + '22';
      ctx.fill();

      // Circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#111';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.font = node.isDepot ? 'bold 11px monospace' : '10px monospace';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(abbreviate(node.name), node.x, node.y - 5);
      
      // Pickup time
      if (node.pickupTime) {
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = '#ffaa00';
        ctx.fillText(node.pickupTime, node.x, node.y + 10);
      }
    });

    // Draw TSP order if available
    if (state.tspRoute && state.tspRoute.length > 1) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#ffaa00';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let i = 0; i < state.tspRoute.length; i++) {
        const node = nodes[state.tspRoute[i]];
        if (i === 0) ctx.moveTo(node.x, node.y);
        else ctx.lineTo(node.x, node.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Draw order numbers
      for (let i = 0; i < state.tspRoute.length - 1; i++) {
        const node = nodes[state.tspRoute[i]];
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = '#ffaa00';
        ctx.textAlign = 'center';
        ctx.fillText(String(i + 1), node.x + 18, node.y - 14);
      }
    }

    ctx.restore();
  }

  function distanceColor(ratio) {
    // Green (#00ff88) → Orange (#ffaa00) → Red (#ff4444)
    let r, g, b;
    if (ratio < 0.5) {
      const t = ratio * 2;
      r = Math.round(0 + t * 255);
      g = Math.round(255 - t * 85);
      b = Math.round(136 - t * 136);
    } else {
      const t = (ratio - 0.5) * 2;
      r = 255;
      g = Math.round(170 - t * 102);
      b = Math.round(0 + t * 68);
    }
    return `rgb(${r},${g},${b})`;
  }

  render();

  // Pan/Zoom handlers
  canvas.addEventListener('mousedown', (e) => {
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    render();
  });

  canvas.addEventListener('mouseup', () => { isPanning = false; });
  canvas.addEventListener('mouseleave', () => { isPanning = false; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Zoom towards cursor
    panX = mx - (mx - panX) * zoomFactor;
    panY = my - (my - panY) * zoomFactor;
    zoom *= zoomFactor;
    zoom = Math.max(0.3, Math.min(5, zoom));
    render();
  }, { passive: false });
}

// ══════════════════════════════════════════════════
// LATEX EXPORT (TikZ with real GPS positions)
// ══════════════════════════════════════════════════
document.getElementById('btn-latex').addEventListener('click', () => {
  if (!state.depot) { setStatus('Fixez d\'abord un dépôt.', 'error'); return; }
  if (state.addresses.length === 0) { setStatus('Ajoutez au moins une adresse.', 'error'); return; }

  const allPoints = [
    { name: state.depot.name, lat: state.depot.lat, lng: state.depot.lng, isDepot: true, pickupTime: null },
    ...state.addresses.map(a => ({ name: a.name, lat: a.lat, lng: a.lng, isDepot: false, pickupTime: a.pickupTime })),
  ];

  // Find bounding box of all points
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  allPoints.forEach(p => {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  });

  // Add padding
  const padLat = (maxLat - minLat) * 0.15 || 0.5;
  const padLng = (maxLng - minLng) * 0.15 || 0.5;
  minLat -= padLat; maxLat += padLat;
  minLng -= padLng; maxLng += padLng;

  // Map GPS coords to TikZ canvas (16cm x 12cm)
  const tikzW = 16;
  const tikzH = 12;
  function toTikz(lat, lng) {
    const x = ((lng - minLng) / (maxLng - minLng)) * tikzW;
    const y = ((lat - minLat) / (maxLat - minLat)) * tikzH;
    return { x: x.toFixed(3), y: y.toFixed(3) };
  }

  // Sanitize name for LaTeX
  function texSafe(s) {
    return s.replace(/[&%$#_{}~^\\]/g, c => '\\' + c);
  }

  // Build the LaTeX document
  let tex = `\\documentclass[border=10pt]{standalone}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{tikz}
\\usetikzlibrary{arrows.meta, positioning, calc}
\\usepackage{xcolor}

\\definecolor{depotred}{HTML}{CC0000}
\\definecolor{routegreen}{HTML}{00AA66}
\\definecolor{routeblue}{HTML}{0077CC}
\\definecolor{routeorange}{HTML}{CC8800}
\\definecolor{tspyellow}{HTML}{CCAA00}

\\begin{document}
\\begin{tikzpicture}[
  every node/.style={font=\\footnotesize\\sffamily},
  depot/.style={circle, fill=depotred, inner sep=0pt, minimum size=5pt},
  addr/.style={circle, fill=black, inner sep=0pt, minimum size=3.5pt},
  lbl/.style={font=\\scriptsize\\sffamily},
  coords/.style={font=\\tiny\\ttfamily, text=gray},
]

% ── Coordonnées GPS réelles projetées ──
% Bounding box: lat [${minLat.toFixed(4)}, ${maxLat.toFixed(4)}], lng [${minLng.toFixed(4)}, ${maxLng.toFixed(4)}]
% Canvas: ${tikzW}cm x ${tikzH}cm
`;

  // Place nodes as small dots with labels beside them
  allPoints.forEach((p, i) => {
    const pos = toTikz(p.lat, p.lng);
    const label = texSafe(p.name);
    const nodeId = p.isDepot ? 'depot' : `addr${i}`;
    const style = p.isDepot ? 'depot' : 'addr';
    // Small dot
    tex += `\\node[${style}] (${nodeId}) at (${pos.x}, ${pos.y}) {};
`;
    // Name label next to the dot
    if (p.isDepot) {
      tex += `\\node[lbl, above right=1pt and 2pt of ${nodeId}, text=depotred, font=\\scriptsize\\bfseries\\sffamily] {${label}};
`;
    } else {
      const pickupLabel = p.pickupTime ? ` [${p.pickupTime}]` : '';
      tex += `\\node[lbl, above right=1pt and 2pt of ${nodeId}] {${label}${pickupLabel}};
`;
    }
    // GPS coordinates below the dot
    tex += `\\node[coords, below=2pt of ${nodeId}] {(${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})};
`;
  });

  tex += `\n% ── Routes dépôt → adresses ──\n`;

  // Draw edges from depot to each address with distance/duration labels
  const routeColors = ['routegreen', 'routeblue', 'routeorange', 'depotred!60!black', 'tspyellow'];
  allPoints.forEach((p, i) => {
    if (p.isDepot) return;
    const nodeId = `addr${i}`;
    const colorName = routeColors[(i - 1) % routeColors.length];

    // Find route data if available
    const addr = state.addresses[i - 1];
    const route = state.routes.find(r => r.addressId === addr.id);

    let labelText = '';
    if (route) {
      const km = (route.distance / 1000).toFixed(1);
      const mins = Math.round(route.duration / 60);
      labelText = `${km}\\,km, ${mins}\\,min`;
    }

    tex += `\\draw[-{Stealth[length=3mm]}, ${colorName}, line width=1pt] (depot) -- node[midway, fill=white, font=\\tiny\\sffamily, inner sep=1pt] {${labelText}} (${nodeId});
`;
  });

  // TSP route if available
  if (state.tspRoute && state.tspRoute.length > 1) {
    tex += `\n% ── Tournée optimisée (TSP nearest-neighbor) ──\n`;
    tex += `\\draw[tspyellow, line width=1.5pt, dashed, -{Stealth[length=3mm]}]\n`;
    const segments = [];
    for (let i = 0; i < state.tspRoute.length; i++) {
      const idx = state.tspRoute[i];
      const nodeId = idx === 0 ? 'depot' : `addr${idx}`;
      segments.push(`  (${nodeId})`);
    }
    tex += segments.join(' --\n') + ';\n';

    // Add step numbers
    tex += `\n% ── Numéros d'ordre de visite ──\n`;
    for (let i = 0; i < state.tspRoute.length - 1; i++) {
      const idx = state.tspRoute[i];
      const nodeId = idx === 0 ? 'depot' : `addr${idx}`;
      tex += `\\node[above right=1mm of ${nodeId}, font=\\tiny\\bfseries, text=tspyellow] {\\#${i + 1}};
`;
    }

    // Total distance
    let totalDist = 0, totalDur = 0;
    if (state.distanceMatrix) {
      for (let i = 0; i < state.tspRoute.length - 1; i++) {
        totalDist += state.distanceMatrix.distances[state.tspRoute[i]][state.tspRoute[i + 1]];
        totalDur += state.distanceMatrix.durations[state.tspRoute[i]][state.tspRoute[i + 1]];
      }
    }
    const totalKm = (totalDist / 1000).toFixed(1);
    const totalMin = Math.round(totalDur / 60);
    tex += `\n% ── Légende ──\n`;
    tex += `\\node[anchor=south east, font=\\footnotesize\\sffamily, text=tspyellow] at (${tikzW}, 0) {Tourn\\'{e}e: ${totalKm}\\,km, ${totalMin}\\,min};
`;
  }

  // Distance matrix as a table if available
  if (state.distanceMatrix) {
    tex += `\n% ── Matrice des distances (km) ──\n`;
    tex += `\\node[anchor=north west, font=\\tiny\\ttfamily, text=gray, align=left] at (0, -0.5) {\n`;
    const names = state.distanceMatrix.names;
    const dist = state.distanceMatrix.distances;
    // Header
    let header = String.raw`\textbf{km}`;
    names.forEach(n => { header += ` & \\textbf{${texSafe(n.substring(0, 5))}}`; });
    tex += header + ` \\\\\n`;
    for (let i = 0; i < names.length; i++) {
      let row = `\\textbf{${texSafe(names[i].substring(0, 5))}}`;
      for (let j = 0; j < names.length; j++) {
        if (i === j) row += ' & ---';
        else row += ` & ${(dist[i][j] / 1000).toFixed(0)}`;
      }
      tex += row + ` \\\\\n`;
    }
    tex += `};\n`;
  }

  // VRP Results
  if (state.vrpResult && state.vrpResult.routes.length > 0) {
    const vrouteColors = ['routegreen', 'routeblue', 'routeorange', 'depotred!60!black', 'tspyellow'];
    tex += `\n% ── Tournées VRP avec Fenêtres de Temps ──\n`;
    tex += `\\node[anchor=north west, font=\\footnotesize\\sffamily, text=white] at (0, ${-tikzH - 1}) {\n`;
    tex += `\\begin{minipage}{${tikzW}cm}\n`;
    tex += `\\centering\\textbf{RÉSULTATS VRP}\\\\[4pt]\n`;
    tex += `\\begin{tabular}{|l|p{5cm}|}\n`;
    tex += `\\hline\n`;
    tex += `\\textbf{Véhicule} & \\textbf{Tournée avec heures de ramassage} \\\\\\hline\n`;
    
    state.vrpResult.routes.forEach((route, vIdx) => {
      const colorName = vrouteColors[vIdx % vrouteColors.length];
      let tourStr = 'Dépôt';
      route.forEach(clientIdx => {
        const addr = state.addresses[clientIdx];
        const pickup = addr.pickupTime || '-';
        tourStr += ` → ${addr.name}[${pickup}]`;
      });
      tourStr += ' → Dépôt';
      tex += `${vIdx + 1} & ${texSafe(tourStr)} \\\\\\hline\n`;
    });
    
    tex += `\\end{tabular}\\\\[6pt]\n`;
    const totalKm = (state.vrpResult.totalDist / 1000).toFixed(1);
    const totalMin = Math.round(state.vrpResult.totalTime);
    tex += `\\textbf{Total}: ${state.vrpResult.vehicles} véhicule(s), ${totalKm}\\,km, ${totalMin}\\,min\n`;
    
    // Parameters
    const maxVehicles = document.getElementById('vrp-vehicles').value;
    const twStart = document.getElementById('vrp-tw-start').value;
    const twEnd = document.getElementById('vrp-tw-end').value;
    tex += `\\textit{Fenêtre de temps: [${twStart}-${twEnd}], Max ${maxVehicles} véhicules}\n`;
    
    tex += `\\end{minipage}\n`;
    tex += `};\n`;
  }

  tex += `\n\\end{tikzpicture}
\\end{document}
`;

  // Download as .tex file
  const blob = new Blob([tex], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tassili_routes.tex';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus('Fichier LaTeX exporté : tassili_routes.tex', 'success');
});

// ══════════════════════════════════════════════════
// SAVE / LOAD DATA
// ══════════════════════════════════════════════════
document.getElementById('btn-save').addEventListener('click', () => {
  const data = {
    depot: state.depot ? {
      name: state.depot.name,
      lat: state.depot.lat,
      lng: state.depot.lng
    } : null,
    addresses: state.addresses.map(a => ({
      name: a.name,
      lat: a.lat,
      lng: a.lng,
      pickupTime: a.pickupTime
    })),
    vrpParams: {
      maxVehicles: document.getElementById('vrp-vehicles').value,
      twStart: document.getElementById('vrp-tw-start').value,
      twEnd: document.getElementById('vrp-tw-end').value
    },
    date: new Date().toISOString()
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tassili_data_' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  setStatus('Données sauvegardées!', 'success');
});

document.getElementById('btn-load').addEventListener('click', () => {
  document.getElementById('file-load').click();
});

document.getElementById('file-load').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    
    // Clear existing data
    clearAll();
    
    // Load depot
    if (data.depot) {
      setDepot(data.depot);
    }
    
    // Load addresses
    if (data.addresses) {
      for (const addr of data.addresses) {
        addAddress(addr);
      }
    }
    
    // Load VRP params
    if (data.vrpParams) {
      document.getElementById('vrp-vehicles').value = data.vrpParams.maxVehicles || 5;
      document.getElementById('vrp-tw-start').value = data.vrpParams.twStart || '08:00';
      document.getElementById('vrp-tw-end').value = data.vrpParams.twEnd || '18:00';
    }
    
    setStatus('Données chargées avec succès!', 'success');
  } catch (err) {
    setStatus('Erreur chargement: ' + err.message, 'error');
  }
  
  e.target.value = '';
});

function clearAll() {
  if (state.depot) {
    map.removeLayer(state.depot.marker);
    state.depot = null;
  }
  state.addresses.forEach(a => map.removeLayer(a.marker));
  state.addresses = [];
  clearRoutes();
  document.getElementById('depot-display').style.display = 'none';
  renderAddressList();
}

// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════
setStatus('Prêt — saisissez un dépôt pour commencer.', '');

// ══════════════════════════════════════════════════
// SIDEBAR TOGGLE
// ══════════════════════════════════════════════════
(function() {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const arrow = document.getElementById('toggle-arrow');
  const label = document.getElementById('toggle-label');
  let isCollapsed = false;

  function updateToggle() {
    if (isCollapsed) {
      arrow.textContent = '▶';
      arrow.style.transform = 'rotate(0deg)';
      label.textContent = 'Menu';
      toggleBtn.classList.add('collapsed-pos');
      toggleBtn.style.left = '0px';
      toggleBtn.title = 'Afficher la barre';
    } else {
      arrow.textContent = '◀';
      arrow.style.transform = 'rotate(0deg)';
      label.textContent = 'Réduire';
      toggleBtn.classList.remove('collapsed-pos');
      toggleBtn.style.left = '400px';
      toggleBtn.title = 'Masquer la barre';
    }
    // Invalidate map size after animation
    setTimeout(() => { map.invalidateSize(); }, 360);
  }

  toggleBtn.addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    sidebar.classList.toggle('collapsed', isCollapsed);
    updateToggle();
  });

  // Keyboard shortcut: press M to toggle
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && !e.ctrlKey && !e.metaKey &&
        document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'TEXTAREA') {
      isCollapsed = !isCollapsed;
      sidebar.classList.toggle('collapsed', isCollapsed);
      updateToggle();
    }
  });
})();
