/**
 * RideSync Dispatch Dashboard - Application Logic
 * Implements polling, grid canvas rendering, tooltips, CSS transitions,
 * and a fully interactive local dispatch simulator.
 */

// --- Configuration and State Management ---
const DEFAULT_CONFIG = {
  dataSource: 'simulated', // 'simulated' | 'live'
  backendUrl: 'http://localhost:8080/state',
  pollInterval: 1000,
  gridCols: 12,
  gridRows: 12
};

let config = { ...DEFAULT_CONFIG };
let state = {
  connected: false,
  activeDriversCount: 0,
  pendingRequestsCount: 0,
  ridesMatchedTotal: 0,
  surgeZonesActiveCount: 0,
  drivers: [],
  riders: [],
  surgeZones: [],
  recentMatches: [],
  seenMatchKeys: new Set() // Tracks uniqueness to avoid double feeding
};

// Cache for driver marker elements in DOM to allow CSS transitions
const driverDOMCache = new Map();
const riderDOMCache = new Map();

// Timer variables
let pollTimerId = null;

// --- DOM Element Selectors ---
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
const settingsDrawer = document.getElementById('settingsDrawer');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

// Config Form fields
const inputDataSource = document.getElementById('dataSource');
const inputBackendUrl = document.getElementById('backendUrl');
const inputPollInterval = document.getElementById('pollInterval');
const inputGridCols = document.getElementById('gridCols');
const inputGridRows = document.getElementById('gridRows');

// Stats DOM nodes
const statActiveDrivers = document.getElementById('statActiveDrivers');
const statPendingRequests = document.getElementById('statPendingRequests');
const statRidesMatched = document.getElementById('statRidesMatched');
const statSurgeZones = document.getElementById('statSurgeZones');
const statSurgeZoneCard = document.getElementById('statSurgeZoneCard');

// Map Layers
const mapCanvasContainer = document.getElementById('mapCanvasContainer');
const gridOverlay = document.getElementById('gridOverlay');
const cityBlocksLayer = document.getElementById('cityBlocksLayer');
const gridLabels = document.getElementById('gridLabels');
const surgeZonesLayer = document.getElementById('surgeZonesLayer');
const ridersLayer = document.getElementById('ridersLayer');
const driversLayer = document.getElementById('driversLayer');
const mapTooltip = document.getElementById('mapTooltip');

// Error Overlay
const mapErrorOverlay = document.getElementById('mapErrorOverlay');
const errorTargetUrl = document.getElementById('errorTargetUrl');
const errorRunSimBtn = document.getElementById('errorRunSimBtn');
const errorRetryBtn = document.getElementById('errorRetryBtn');

// Activity Feed
const feedContainer = document.getElementById('feedContainer');
const feedEmptyState = document.getElementById('feedEmptyState');
const feedMatchedCount = document.getElementById('feedMatchedCount');


// --- Initialize Application ---
function init() {
  loadConfig();
  syncConfigUI();
  setupEventListeners();
  applyGridCSS();
  drawGridCoordinateLabels();
  drawCityBlocks();
  
  if (config.dataSource === 'simulated') {
    initSimulation();
  }
  
  startPollingLoop();
}

// Load configurations from LocalStorage
function loadConfig() {
  const saved = localStorage.getItem('ridesync_config');
  if (saved) {
    try {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    } catch (e) {
      console.warn('Failed to parse config from localStorage', e);
    }
  }
}

// Save configurations to LocalStorage
function saveConfig() {
  localStorage.setItem('ridesync_config', JSON.stringify(config));
}

// Sync values from config object to input form elements
function syncConfigUI() {
  inputDataSource.value = config.dataSource;
  inputBackendUrl.value = config.backendUrl;
  inputPollInterval.value = config.pollInterval;
  inputGridCols.value = config.gridCols;
  inputGridRows.value = config.gridRows;

  // Toggle backend url input state depending on source
  inputBackendUrl.disabled = config.dataSource === 'simulated';
}

// Apply Grid rows/cols dynamically to CSS custom properties
function applyGridCSS() {
  document.documentElement.style.setProperty('--grid-columns', config.gridCols);
  document.documentElement.style.setProperty('--grid-rows', config.gridRows);
}

// Draw X & Y grid coordinate labels directly aligned to street centerlines
function drawGridCoordinateLabels() {
  gridLabels.innerHTML = '';
  const cols = config.gridCols;
  const rows = config.gridRows;

  // Draw X axis labels (bottom border)
  for (let x = 0; x < cols; x++) {
    const label = document.createElement('div');
    label.className = 'grid-label-x';
    label.innerText = x;
    label.style.left = `calc((100% / ${cols - 1}) * ${x})`;
    label.style.bottom = '4px';
    label.style.transform = 'translateX(-50%)';
    gridLabels.appendChild(label);
  }

  // Draw Y axis labels (left border)
  for (let y = 0; y < rows; y++) {
    const label = document.createElement('div');
    label.className = 'grid-label-y';
    label.innerText = y;
    label.style.bottom = `calc((100% / ${rows - 1}) * ${y})`;
    label.style.left = '6px';
    label.style.transform = 'translateY(50%)';
    gridLabels.appendChild(label);
  }
}

// Generate the underlying city blocks (buildings, parks, rivers) in grid spaces
function drawCityBlocks() {
  cityBlocksLayer.innerHTML = '';
  const cols = config.gridCols;
  const rows = config.gridRows;

  // Seeded deterministic random generator to maintain consistent urban designs
  function getSeededRandom(x, y) {
    const sx = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return sx - Math.floor(sx);
  }

  // City blocks sit between the grid/road lines, so there are (cols-1)*(rows-1) blocks.
  for (let x = 0; x < cols - 1; x++) {
    for (let y = 0; y < rows - 1; y++) {
      const block = document.createElement('div');
      
      // Layout dimensions matching cell margins to represent road sizes
      block.style.left = `calc(((100% / ${cols - 1}) * ${x}) + 4px)`;
      block.style.top = `calc(((100% / ${rows - 1}) * (${rows - 2 - y})) + 4px)`;
      block.style.width = `calc((100% / ${cols - 1}) - 8px)`;
      block.style.height = `calc((100% / ${rows - 1}) - 8px)`;

      const rand = getSeededRandom(x, y);
      let blockClass = 'residential';
      let labelText = '';

      // Create a nice organic layout
      // Waterway canal running down
      if (x === 1 && y >= 2 && y <= rows - 4) {
        blockClass = 'water';
        if (y === Math.floor(rows/2)) labelText = 'East River';
      }
      // Green Parks
      else if (x >= cols - 4 && x <= cols - 3 && y >= rows - 5 && y <= rows - 4) {
        blockClass = 'park';
        if (x === cols - 4 && y === rows - 4) labelText = 'Central Park';
      }
      // Commercial Skyscrapers
      else if (rand > 0.78) {
        blockClass = 'commercial';
        if (rand > 0.94) labelText = 'Office HQ';
        else if (rand > 0.88) labelText = 'Shopping';
        else labelText = 'District';
      }
      // Standard Residential blocks
      else {
        blockClass = 'residential';
        if (rand < 0.1) labelText = 'Apartments';
      }

      block.className = `city-block ${blockClass}`;

      if (labelText) {
        const label = document.createElement('span');
        label.className = 'city-block-label';
        label.innerText = labelText;
        block.appendChild(label);
      }

      cityBlocksLayer.appendChild(block);
    }
  }
}

// Setup all click handlers and bindings
function setupEventListeners() {
  // Toggle Settings Panel
  toggleSettingsBtn.addEventListener('click', () => {
    settingsDrawer.classList.toggle('open');
  });

  // Source drop-down change toggle
  inputDataSource.addEventListener('change', () => {
    inputBackendUrl.disabled = inputDataSource.value === 'simulated';
  });

  // Save Settings
  saveSettingsBtn.addEventListener('click', () => {
    config.dataSource = inputDataSource.value;
    config.backendUrl = inputBackendUrl.value.trim();
    config.pollInterval = parseInt(inputPollInterval.value) || 1000;
    config.gridCols = parseInt(inputGridCols.value) || 12;
    config.gridRows = parseInt(inputGridRows.value) || 12;

    saveConfig();
    applyGridCSS();
    drawGridCoordinateLabels();
    drawCityBlocks();
    settingsDrawer.classList.remove('open');

    // Clear caches for redrawing
    clearMapDOM();

    // Restart simulator if switching to it
    if (config.dataSource === 'simulated') {
      initSimulation();
    }

    // Restart timer loop
    restartPollingLoop();
  });

  // Handle overlay buttons
  errorRunSimBtn.addEventListener('click', () => {
    config.dataSource = 'simulated';
    syncConfigUI();
    saveConfig();
    clearMapDOM();
    drawCityBlocks();
    initSimulation();
    restartPollingLoop();
  });

  errorRetryBtn.addEventListener('click', () => {
    triggerPoll();
  });

  // Global mousemove to hide tooltips if they hover away from driver cards
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.driver-marker')) {
      hideTooltip();
    }
  });
}

// Clear all rendered nodes from map
function clearMapDOM() {
  driversLayer.innerHTML = '';
  ridersLayer.innerHTML = '';
  surgeZonesLayer.innerHTML = '';
  driverDOMCache.clear();
  riderDOMCache.clear();
}

// --- Polling Loops & Backend Integration ---
function startPollingLoop() {
  triggerPoll();
  pollTimerId = setInterval(triggerPoll, config.pollInterval);
}

function restartPollingLoop() {
  if (pollTimerId) {
    clearInterval(pollTimerId);
  }
  startPollingLoop();
}

function triggerPoll() {
  if (config.dataSource === 'simulated') {
    // Run local simulation step
    const simulatedState = stepSimulation();
    setConnectionState('simulated');
    updateDashboard(simulatedState);
  } else {
    // Fetch live state from C++ backend endpoint
    fetch(config.backendUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP Error Status: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        setConnectionState('connected');
        updateDashboard(data);
      })
      .catch(err => {
        console.error('Backend poll failure:', err);
        setConnectionState('disconnected');
      });
  }
}

// Update UI indicator badges
function setConnectionState(status) {
  if (status === 'connected') {
    statusBadge.className = 'status-badge connected';
    statusText.innerText = 'Live API';
    mapErrorOverlay.classList.remove('visible');
  } else if (status === 'simulated') {
    statusBadge.className = 'status-badge simulated';
    statusText.innerText = 'Simulation Active';
    mapErrorOverlay.classList.remove('visible');
  } else {
    statusBadge.className = 'status-badge';
    statusText.innerText = 'Disconnected';
    
    // Set target URL for debugging help
    errorTargetUrl.innerText = config.backendUrl;
    mapErrorOverlay.classList.add('visible');
  }
}


// --- Main Dashboard Rendering ---
function updateDashboard(data) {
  if (!data) return;

  // 1. Update stats indicators
  updateStatsBar(data.stats);

  // 2. Draw surge overlays
  renderSurgeZones(data.surge_zones || []);

  // 3. Draw rider location pins
  renderRiders(data.riders || []);

  // 4. Draw/animate driver cars
  renderDrivers(data.drivers || []);

  // 5. Populate activity matched feed
  renderActivityFeed(data.recent_matches || []);
}

// Updates numeric cards at the top
function updateStatsBar(stats) {
  if (!stats) return;

  animateStatChange(statActiveDrivers, stats.active_drivers);
  animateStatChange(statPendingRequests, stats.pending_requests);
  animateStatChange(statRidesMatched, stats.rides_matched_total);
  animateStatChange(statSurgeZones, stats.surge_zones_active);

  // Accent the surge card when surge count is > 0
  if (stats.surge_zones_active > 0) {
    statSurgeZoneCard.classList.add('active');
  } else {
    statSurgeZoneCard.classList.remove('active');
  }
}

function animateStatChange(element, newValue) {
  const oldValue = parseInt(element.innerText) || 0;
  if (oldValue !== newValue) {
    element.innerText = newValue;
    // Simple micro-interaction pulse
    element.style.transform = 'scale(1.05)';
    element.style.transition = 'transform 0.1s ease';
    setTimeout(() => {
      element.style.transform = 'scale(1)';
    }, 100);
  }
}

// Translates (x, y) coordinates to percentage values directly matching street intersections
function getPercentPosition(x, y) {
  const cols = config.gridCols;
  const rows = config.gridRows;
  
  // Coordinates range from 0 to N-1
  const percentX = (x / (cols - 1)) * 100;
  const percentY = ((rows - 1 - y) / (rows - 1)) * 100;

  return {
    left: percentX,
    top: percentY
  };
}

// Render Heatmap zones representing Surge Areas covering block boundaries
function renderSurgeZones(zones) {
  surgeZonesLayer.innerHTML = '';
  
  const cols = config.gridCols;
  const rows = config.gridRows;

  zones.forEach(zone => {
    const overlay = document.createElement('div');
    overlay.className = 'surge-overlay';
    
    // A surge block runs from x_min to x_max + 1 and y_min to y_max + 1
    const leftPercent = (zone.x_min / (cols - 1)) * 100;
    const topPercent = ((rows - 1 - (zone.y_max + 1)) / (rows - 1)) * 100;
    const widthPercent = ((zone.x_max + 1 - zone.x_min) / (cols - 1)) * 100;
    const heightPercent = ((zone.y_max + 1 - zone.y_min) / (rows - 1)) * 100;

    overlay.style.left = `${leftPercent}%`;
    overlay.style.top = `${topPercent}%`;
    overlay.style.width = `${widthPercent}%`;
    overlay.style.height = `${heightPercent}%`;
    
    overlay.title = `${zone.multiplier}x Surge`;
    
    surgeZonesLayer.appendChild(overlay);
  });
}

// Render Riders / Booking Pins
function renderRiders(riders) {
  const currentRiderIds = new Set(riders.map(r => r.id));

  // Remove riders not present in incoming state
  for (const [id, marker] of riderDOMCache.entries()) {
    if (!currentRiderIds.has(id)) {
      marker.remove();
      riderDOMCache.delete(id);
    }
  }

  // Draw or update active riders
  riders.forEach(rider => {
    const pos = getPercentPosition(rider.x, rider.y);
    let marker = riderDOMCache.get(rider.id);

    if (!marker) {
      marker = document.createElement('div');
      marker.className = 'rider-marker';
      marker.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none"><use href="#icon-pin"/></svg>
        <div class="rider-shadow"></div>
      `;
      ridersLayer.appendChild(marker);
      riderDOMCache.set(rider.id, marker);
    }

    // Set position
    marker.style.left = `${pos.left}%`;
    marker.style.top = `${pos.top}%`;
  });
}

// Render Drivers (Cars) with transition animations
function renderDrivers(drivers) {
  const currentDriverIds = new Set(drivers.map(d => d.id));

  // Delete drivers no longer reported
  for (const [id, marker] of driverDOMCache.entries()) {
    if (!currentDriverIds.has(id)) {
      marker.remove();
      driverDOMCache.delete(id);
    }
  }

  drivers.forEach(driver => {
    const pos = getPercentPosition(driver.x, driver.y);
    let marker = driverDOMCache.get(driver.id);
    let prevPos = null;

    if (marker) {
      prevPos = {
        x: parseFloat(marker.dataset.x),
        y: parseFloat(marker.dataset.y)
      };
    }

    if (!marker) {
      // Create new driver element
      marker = document.createElement('div');
      marker.className = `driver-marker ${driver.status}`;
      marker.dataset.id = driver.id;
      marker.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <!-- Wheels -->
          <rect x="2" y="4" width="3" height="4" rx="1" fill="#1e293b"/>
          <rect x="19" y="4" width="3" height="4" rx="1" fill="#1e293b"/>
          <rect x="2" y="16" width="3" height="4" rx="1" fill="#1e293b"/>
          <rect x="19" y="16" width="3" height="4" rx="1" fill="#1e293b"/>

          <!-- Main Body -->
          <path class="car-chassis" d="M 5 6 C 5 2, 8 1, 12 1 C 16 1, 19 2, 19 6 L 20 18 C 20 22, 16 23, 12 23 C 8 23, 4 22, 4 18 Z" fill="#10b981"/>

          <!-- Front Bumper Highlight -->
          <path d="M 6 3 Q 12 1 18 3" stroke="#ffffff" stroke-width="1" stroke-linecap="round" opacity="0.3"/>

          <!-- Front Windshield -->
          <path d="M 6 8 Q 12 5.5 18 8 L 17 11 H 7 Z" fill="#0f172a"/>
          <path d="M 7 8.5 Q 12 6.5 17 8.5 L 16 10 H 8 Z" fill="#334155"/>

          <!-- Roof -->
          <rect class="car-roof" x="7.5" y="11" width="9" height="7" rx="1.5" fill="#10b981" />
          <rect x="8.5" y="11.5" width="7" height="6" rx="1" fill="#ffffff" opacity="0.2"/>

          <!-- Rear Windshield -->
          <path d="M 7.5 18 H 16.5 L 17.5 20 Q 12 21.5 6.5 20 Z" fill="#0f172a"/>

          <!-- Mirrors -->
          <rect class="car-mirror" x="3" y="8" width="2" height="3" rx="1" fill="#10b981"/>
          <rect class="car-mirror" x="19" y="8" width="2" height="3" rx="1" fill="#10b981"/>

          <!-- Headlights -->
          <rect x="6" y="1.5" width="3" height="1.5" rx="0.5" fill="#fef08a"/>
          <rect x="15" y="1.5" width="3" height="1.5" rx="0.5" fill="#fef08a"/>

          <!-- Taillights -->
          <rect x="6" y="21.5" width="3.5" height="1" rx="0.5" fill="#ef4444"/>
          <rect x="14.5" y="21.5" width="3.5" height="1" rx="0.5" fill="#ef4444"/>
        </svg>
      `;
      
      // Event logic for tooltip
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        showTooltip(driver, marker);
      });
      
      driversLayer.appendChild(marker);
      driverDOMCache.set(driver.id, marker);
    }

    // Cache current grid position values
    marker.dataset.x = driver.x;
    marker.dataset.y = driver.y;

    // Check status changes to change color
    marker.className = `driver-marker ${driver.status}`;
    
    // Explicitly inject SVG fill attributes to bypass all CSS inheritance bugs
    const carColor = driver.status === 'available' ? '#10b981' : '#94a3b8';
    marker.querySelectorAll('.car-chassis, .car-roof, .car-mirror').forEach(el => {
      el.setAttribute('fill', carColor);
    });

    // Stable offset logic for visual separation to prevent overlapping
    let hash = 0;
    for (let i = 0; i < String(driver.id).length; i++) {
      hash = String(driver.id).charCodeAt(i) + ((hash << 5) - hash);
    }
    const offsetX = ((Math.abs(hash) % 31) / 10) - 1.5;
    const offsetY = ((Math.abs(hash >> 3) % 31) / 10) - 1.5;

    // Apply movement positioning
    marker.style.left = `${pos.left + offsetX}%`;
    marker.style.top = `${pos.top + offsetY}%`;

    // Rotate driver based on directional heading
    let heading = driver.heading_deg || 0;

    // If heading isn't specified but position changed, calculate heading bearing
    if (driver.heading_deg === undefined && prevPos && (prevPos.x !== driver.x || prevPos.y !== driver.y)) {
      const dx = driver.x - prevPos.x;
      const dy = driver.y - prevPos.y;
      
      // Calculate angle relative to upward vector.
      // dy values in standard grids increment upwards.
      let angle = Math.atan2(dx, dy) * (180 / Math.PI); // degrees
      if (angle < 0) angle += 360;
      heading = angle;
    }

    marker.style.transform = `rotate(${heading}deg)`;
  });
}

// Show Tooltip Detail popover adjacent to driver node
function showTooltip(driver, markerElement) {
  // Grab bounding coords of the container relative to document
  const mapRect = mapCanvasContainer.getBoundingClientRect();
  const markerRect = markerElement.getBoundingClientRect();

  // Compute absolute left & top relative to parent container
  const relativeLeft = markerRect.left - mapRect.left + (markerRect.width / 2);
  const relativeTop = markerRect.top - mapRect.top - 10; // offset slightly above marker

  mapTooltip.innerHTML = `
    <div class="tooltip-header">
      <span>Driver ${driver.id}</span>
      <span class="status-dot" style="background-color: ${driver.status === 'available' ? 'var(--color-available)' : 'var(--color-busy)'}"></span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Status:</span>
      <span class="tooltip-value" style="text-transform: capitalize; color: ${driver.status === 'available' ? 'var(--color-available)' : 'var(--text-secondary)'}">${driver.status}</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Coordinates:</span>
      <span class="tooltip-value">(${driver.x}, ${driver.y})</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Heading:</span>
      <span class="tooltip-value">${driver.heading_deg !== undefined ? driver.heading_deg + '°' : 'N/A'}</span>
    </div>
  `;

  // Align popover center on target element
  mapTooltip.style.left = `${relativeLeft}px`;
  mapTooltip.style.top = `${relativeTop}px`;
  mapTooltip.style.transform = 'translate(-50%, -100%)';
  mapTooltip.classList.add('visible');
}

function hideTooltip() {
  mapTooltip.classList.remove('visible');
}

// Renders the Recent Matches list
function renderActivityFeed(matches) {
  if (!matches || matches.length === 0) {
    if (feedContainer.children.length === 1 && feedContainer.children[0] === feedEmptyState) {
      feedEmptyState.style.display = 'block';
    }
    return;
  }

  // Remove empty state
  feedEmptyState.style.display = 'none';
  feedMatchedCount.innerText = `${state.ridesMatchedTotal || matches.length} matches`;

  // Process matches in chronological order (oldest first to insert correctly)
  const sortedMatches = [...matches].reverse();

  sortedMatches.forEach(match => {
    // Unique signature key
    const matchKey = `${match.driver_id}_${match.rider_id}_${match.timestamp}`;

    if (!state.seenMatchKeys.has(matchKey)) {
      state.seenMatchKeys.add(matchKey);

      // Create new activity card item
      const item = document.createElement('div');
      item.className = 'feed-item';

      // Parse timestamp
      let formattedTime = 'Just now';
      if (match.timestamp) {
        try {
          const date = new Date(match.timestamp);
          formattedTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch(e) {}
      }

      const surgeBadgeHtml = match.surge_multiplier > 1.0 
        ? `<span class="surge-badge">${match.surge_multiplier.toFixed(1)}x surge</span>` 
        : '';

      item.innerHTML = `
        <div class="feed-item-header">
          <div class="match-info">
            <span>${match.driver_id}</span>
            <span class="match-arrow">➔</span>
            <span>${match.rider_id}</span>
          </div>
          <span class="match-timestamp">${formattedTime}</span>
        </div>
        <div class="feed-item-details">
          <span class="match-eta">ETA: ${match.eta_min.toFixed(1)} mins</span>
          <span class="match-fare">
            ${surgeBadgeHtml}
            $${match.fare.toFixed(2)}
          </span>
        </div>
      `;

      // Insert at the top of container (newest matches first)
      if (feedContainer.firstChild) {
        feedContainer.insertBefore(item, feedContainer.firstChild);
      } else {
        feedContainer.appendChild(item);
      }

      // Constrain DOM feed list size to avoid bloated browser DOM
      if (feedContainer.children.length > 50) {
        feedContainer.lastElementChild.remove();
      }
    }
  });
}


// ==========================================
// --- Interactive Local Mock Simulator ---
// ==========================================
let simDrivers = [];
let simRiders = [];
let simSurgeZones = [];
let simMatchedCount = 0;
let simRiderCounter = 1;
let simRecentMatches = [];

// Initialize mockup drivers and zones
function initSimulation() {
  simDrivers = [];
  simRiders = [];
  simRecentMatches = [];
  simMatchedCount = 20; // Start visual counter from 20 to mimic continuous execution
  simRiderCounter = 1;
  state.seenMatchKeys.clear();

  // Clear feed container elements except empty states
  feedContainer.innerHTML = '';
  feedContainer.appendChild(feedEmptyState);
  feedEmptyState.style.display = 'block';

  const cols = config.gridCols;
  const rows = config.gridRows;

  // Initialize 10 drivers randomly spaced on grid
  for (let i = 1; i <= 10; i++) {
    const id = `D${i < 10 ? '0' + i : i}`;
    simDrivers.push({
      id: id,
      x: Math.floor(Math.random() * cols),
      y: Math.floor(Math.random() * rows),
      status: 'available',
      heading_deg: Math.floor(Math.random() * 4) * 90,
      
      // Destination values for busy routing
      destX: null,
      destY: null,
      passengerId: null
    });
  }

  // Pre-seed 3 active riders/pickup points
  for (let i = 1; i <= 3; i++) {
    spawnMockRider();
  }

  // Pre-seed 1 active Surge zone
  simSurgeZones = [
    {
      x_min: Math.floor(cols * 0.5),
      y_min: Math.floor(rows * 0.2),
      x_max: Math.floor(cols * 0.5) + 2,
      y_max: Math.floor(rows * 0.2) + 2,
      multiplier: 1.6
    }
  ];
}

// Generate new rider request
function spawnMockRider() {
  const cols = config.gridCols;
  const rows = config.gridRows;
  const riderId = `R${simRiderCounter++}`;
  
  simRiders.push({
    id: riderId,
    x: Math.floor(Math.random() * cols),
    y: Math.floor(Math.random() * rows),
    age: 0
  });
}

// Helper to determine if cell resides inside surge zones
function getSurgeMultiplier(x, y) {
  for (const zone of simSurgeZones) {
    if (x >= zone.x_min && x <= zone.x_max && y >= zone.y_min && y <= zone.y_max) {
      return zone.multiplier;
    }
  }
  return 1.0;
}

// Progresses local simulation state by one tick
function stepSimulation() {
  const cols = config.gridCols;
  const rows = config.gridRows;

  // 1. Move Drivers
  simDrivers.forEach(driver => {
    if (driver.status === 'available') {
      // Wandering: move randomly to an adjacent cell (4-directional)
      const directions = [
        { dx: 0, dy: 1, angle: 0 },    // North
        { dx: 1, dy: 0, angle: 90 },   // East
        { dx: 0, dy: -1, angle: 180 }, // South
        { dx: -1, dy: 0, angle: 270 }  // West
      ];

      // Filter directions keeping driver within grid boundaries
      const validDirs = directions.filter(d => {
        const nextX = driver.x + d.dx;
        const nextY = driver.y + d.dy;
        return nextX >= 0 && nextX < cols && nextY >= 0 && nextY < rows;
      });

      if (validDirs.length > 0) {
        const chosen = validDirs[Math.floor(Math.random() * validDirs.length)];
        driver.x += chosen.dx;
        driver.y += chosen.dy;
        driver.heading_deg = chosen.angle;
      }
    } else {
      // Busy: Navigating to destination coordinate (simulating transit)
      const dx = driver.destX - driver.x;
      const dy = driver.destY - driver.y;

      if (dx !== 0 || dy !== 0) {
        // Move 1 coordinate step closer (Manhattan grid routing)
        if (Math.abs(dx) >= Math.abs(dy)) {
          const step = Math.sign(dx);
          driver.x += step;
          driver.heading_deg = step > 0 ? 90 : 270;
        } else {
          const step = Math.sign(dy);
          driver.y += step;
          driver.heading_deg = step > 0 ? 0 : 180;
        }
      } else {
        // Destination reached: Complete ride, free driver
        driver.status = 'available';
        driver.destX = null;
        driver.destY = null;
        driver.passengerId = null;
      }
    }
  });

  // 2. Spawn Riders periodically (30% chance per step, capped at 6)
  if (Math.random() < 0.3 && simRiders.length < 6) {
    spawnMockRider();
  }

  // 3. Match Available Drivers to Riders (Nearest Neighbour)
  const matchedRiderIndices = new Set();
  
  simRiders.forEach((rider, riderIdx) => {
    rider.age = (rider.age || 0) + 1;
    if (rider.age < 2) return; // Wait 1-2 ticks before matching so pin is visible

    let nearestDriver = null;
    let minDistance = Infinity;

    simDrivers.forEach(driver => {
      if (driver.status === 'available') {
        const dist = Math.abs(driver.x - rider.x) + Math.abs(driver.y - rider.y);
        if (dist < minDistance) {
          minDistance = dist;
          nearestDriver = driver;
        }
      }
    });

    // Match found!
    if (nearestDriver && minDistance < 8) { // Only match if driver is relatively close
      matchedRiderIndices.add(riderIdx);
      
      // Update driver state
      nearestDriver.status = 'busy';
      // Set dropoff destination randomly on opposite side of grid
      nearestDriver.destX = Math.floor(Math.random() * cols);
      nearestDriver.destY = Math.floor(Math.random() * rows);
      nearestDriver.passengerId = rider.id;

      simMatchedCount++;

      // Surge Pricing Multiplier check
      const surgeMultiplier = getSurgeMultiplier(rider.x, rider.y);
      const baseFare = 5.0 + minDistance * 1.5;
      const finalFare = baseFare * surgeMultiplier;
      const eta = minDistance * 0.5 + 1.0;

      // Add to matches array
      const matchRecord = {
        driver_id: nearestDriver.id,
        rider_id: rider.id,
        eta_min: eta,
        fare: finalFare,
        surge_multiplier: surgeMultiplier,
        timestamp: new Date().toISOString()
      };

      // Keep recent matches list capped at 10 items
      simRecentMatches.unshift(matchRecord);
      if (simRecentMatches.length > 10) {
        simRecentMatches.pop();
      }
    }
  });

  // Remove matched riders from list
  simRiders = simRiders.filter((_, idx) => !matchedRiderIndices.has(idx));

  // 4. Update Surge Zones dynamically (sometimes change position or multiplier)
  if (Math.random() < 0.1) {
    if (Math.random() < 0.5 && simSurgeZones.length > 0) {
      // Remove a surge zone
      simSurgeZones.pop();
    } else if (simSurgeZones.length < 2) {
      // Add a new surge zone
      const sizeX = 2 + Math.floor(Math.random() * 2);
      const sizeY = 2 + Math.floor(Math.random() * 2);
      const startX = Math.floor(Math.random() * (cols - sizeX));
      const startY = Math.floor(Math.random() * (rows - sizeY));
      
      simSurgeZones.push({
        x_min: startX,
        y_min: startY,
        x_max: startX + sizeX,
        y_max: startY + sizeY,
        multiplier: parseFloat((1.3 + Math.random() * 0.8).toFixed(1))
      });
    }
  }

  // Construct resulting JSON payload
  return {
    stats: {
      active_drivers: simDrivers.length,
      pending_requests: simRiders.length,
      rides_matched_total: simMatchedCount,
      surge_zones_active: simSurgeZones.length
    },
    drivers: simDrivers.map(d => ({
      id: d.id,
      x: d.x,
      y: d.y,
      status: d.status,
      heading_deg: d.heading_deg
    })),
    riders: simRiders,
    surge_zones: simSurgeZones,
    recent_matches: simRecentMatches
  };
}

// Start application
document.addEventListener('DOMContentLoaded', init);
