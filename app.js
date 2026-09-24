// ===========================================================================
// STAND HERE — Visual Ride Match
// Peer-to-peer version: two phones, no dispatch backend, no account signups.
// Sync is direct phone-to-phone over WebRTC (PeerJS's free public broker
// just handles the initial handshake); matched by a shared meeting-location
// text that both phones hash into the same identifier + rendezvous ID.
// ===========================================================================

const CFG = window.STAND_HERE_CONFIG || {};
const CLOSE_M = CFG.closeThresholdMeters ?? 150;
const ARRIVE_M = CFG.arrivalThresholdMeters ?? 25;
const DIRECTIONS_POLL_MS = CFG.directionsPollMs ?? 20000;

const COLORS = [
  { name: "BLUE", hex: "#4C8DFF" },
  { name: "GREEN", hex: "#3ECF8E" },
  { name: "ORANGE", hex: "#FF8A3D" },
  { name: "PURPLE", hex: "#B980FF" },
  { name: "RED", hex: "#FF5C6C" },
  { name: "TEAL", hex: "#2FD2CC" }
];
const SHAPES = ["▲", "●", "■", "◆"]; // ▲ ● ■ ◆

// ---------------------------------------------------------------------------
// Deterministic ride identifier from the shared location text
// ---------------------------------------------------------------------------

function slugify(text) {
  return text.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// Simple DJB2-style string hash -> stable 32-bit integer
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return Math.abs(hash);
}

function identifierFromLocation(locationText) {
  const key = slugify(locationText);
  const h = hashString(key);
  const color = COLORS[h % COLORS.length];
  const shape = SHAPES[Math.floor(h / COLORS.length) % SHAPES.length];
  const code = 10 + (Math.floor(h / (COLORS.length * SHAPES.length)) % 90);
  return { sessionKey: key, colorName: color.name, colorHex: color.hex, shape, code };
}

// ---------------------------------------------------------------------------
// Distance math
// ---------------------------------------------------------------------------

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m) {
  if (m == null || Number.isNaN(m)) return "—";
  return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
}

// Real walking distance/ETA via Mapbox Directions API (optional enhancement —
// only used if a token is set in config.js; the app works fully without it).
// Returns { meters, seconds } or null if unavailable/unconfigured/failed.
async function fetchWalkingRoute(fromLat, fromLng, toLat, toLng) {
  const token = CFG.mapboxToken;
  if (!token) return null;
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/` +
    `${fromLng},${fromLat};${toLng},${toLat}` +
    `?overview=false&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) return null;
    return { meters: route.distance, seconds: route.duration };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Match sound — a short two-tone chime via the Web Audio API. No audio file
// needed, and it works alongside (or instead of) vibration when someone
// isn't looking at their screen.
// ---------------------------------------------------------------------------

let audioCtx = null;

function unlockAudio() {
  // Must be called from inside a real user gesture (a click/tap handler) —
  // browsers block audio from starting on its own.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}

function playTone(freq, startTime, duration) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

function playMatchChime() {
  // Three quick ascending beeps — reads unambiguously as "confirmed match"
  // rather than a generic notification blip, and stays audible over street
  // noise without sounding like an alarm.
  try {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    playTone(659.25, now, 0.11);        // E5
    playTone(880, now + 0.14, 0.11);    // A5
    playTone(1318.5, now + 0.28, 0.22); // E6, held slightly longer to land the confirmation
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let mode = null; // "live" | "demo"
let identifier = null;
let appState = "SEARCHING"; // SEARCHING -> FAR -> CLOSE -> MATCHED
let vibrationSupported = false;

let myWatchId = null;
let otherLocation = null; // { lat, lng }
let myLocation = null;    // { lat, lng }
let directionsTimer = null;
let demoOtherDistance = 640; // meters, used only in demo mode
let liveDistanceMeters = null;
let routeInfo = null; // { meters, seconds } from Mapbox, or null

// PeerJS connection state
let peer = null;
let conn = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const el = {
  screenJoin: document.getElementById("screen-join"),
  screenMatch: document.getElementById("screen-match"),
  locationInput: document.getElementById("location-input"),
  identifierPreview: document.getElementById("identifier-preview"),
  previewBadge: document.getElementById("preview-badge"),
  btnJoinLive: document.getElementById("btn-join-live"),
  btnJoinDemo: document.getElementById("btn-join-demo"),
  joinError: document.getElementById("join-error"),
  btnLeave: document.getElementById("btn-leave"),
  headline: document.getElementById("headline"),
  bigDistanceBlock: document.getElementById("big-distance-block"),
  bigDistance: document.getElementById("big-distance"),
  subDistance: document.getElementById("sub-distance"),
  badgeBlock: document.getElementById("badge-block"),
  matchBadge: document.getElementById("match-badge"),
  locationNote: document.getElementById("location-note"),
  errorBlock: document.getElementById("error-block"),
  vibrationStatus: document.getElementById("vibration-status"),
  demoPanel: document.getElementById("demo-panel"),
  btnSimulateApproach: document.getElementById("btn-simulate-approach"),
  btnResetDemo: document.getElementById("btn-reset-demo"),
  glow: document.getElementById("glow")
};

vibrationSupported = typeof navigator !== "undefined" && "vibrate" in navigator;
el.vibrationStatus.textContent = vibrationSupported
  ? "Haptics: supported · Sound: on at match"
  : "Haptics: not supported on this device — glow + sound will confirm instead";

// ---------------------------------------------------------------------------
// Join screen behavior
// ---------------------------------------------------------------------------

el.locationInput.addEventListener("input", () => {
  const val = el.locationInput.value;
  if (val.trim().length >= 2) {
    const preview = identifierFromLocation(val);
    el.identifierPreview.classList.remove("hidden");
    paintBadge(el.previewBadge, preview);
    el.btnJoinLive.disabled = false;
  } else {
    el.identifierPreview.classList.add("hidden");
    el.btnJoinLive.disabled = true;
  }
});

function paintBadge(node, ident) {
  node.textContent = `${ident.colorName} ${ident.shape} ${String(ident.code).padStart(2, "0")}`;
  node.style.color = ident.colorHex;
  node.style.borderColor = ident.colorHex;
}

el.btnJoinDemo.addEventListener("click", () => {
  unlockAudio();
  const text = el.locationInput.value.trim() || "demo-meetup";
  identifier = identifierFromLocation(text);
  startSession("demo");
});

el.btnJoinLive.addEventListener("click", () => {
  unlockAudio();
  const text = el.locationInput.value.trim();
  if (!text) return;
  identifier = identifierFromLocation(text);
  startSession("live");
});

function showJoinError(msg) {
  el.joinError.textContent = msg;
  el.joinError.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function startSession(chosenMode) {
  mode = chosenMode;
  appState = "SEARCHING";
  otherLocation = null;
  myLocation = null;
  liveDistanceMeters = null;
  routeInfo = null;
  demoOtherDistance = 640;

  el.screenJoin.classList.add("hidden");
  el.screenMatch.classList.remove("hidden");
  el.locationNote.textContent = `Meeting at: ${el.locationInput.value.trim() || "demo-meetup"}`;
  el.demoPanel.classList.toggle("hidden", mode !== "demo");
  el.btnResetDemo.classList.add("hidden");
  el.btnSimulateApproach.classList.remove("hidden");
  hideRuntimeError();

  render();

  if (mode === "live") {
    startOwnGeolocation();
    startPeerSync();
  }
}

el.btnLeave.addEventListener("click", () => {
  teardownSession();
  el.screenMatch.classList.add("hidden");
  el.screenJoin.classList.remove("hidden");
});

function teardownSession() {
  if (myWatchId != null && navigator.geolocation && navigator.geolocation.clearWatch) {
    navigator.geolocation.clearWatch(myWatchId);
  }
  myWatchId = null;
  if (directionsTimer) {
    clearInterval(directionsTimer);
    directionsTimer = null;
  }
  if (conn) {
    try { conn.close(); } catch (e) {}
    conn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
}

// ---------------------------------------------------------------------------
// LIVE mode: direct phone-to-phone sync over WebRTC (PeerJS)
//
// No account, no server of our own. Both phones hash the same location text
// into the same sessionKey. Whichever phone opens first claims the peer ID
// "<sessionKey>-a"; PeerJS enforces unique IDs across its whole public
// network, so the second phone's attempt to claim that same ID fails with
// an "unavailable-id" error — which is exactly how it learns "I'm second"
// and instead connects TO that ID. No manual host/guest picking needed.
// ---------------------------------------------------------------------------

function startPeerSync() {
  if (typeof Peer === "undefined") {
    showRuntimeError("Couldn't load the connection library — check your internet connection and reload.");
    return;
  }

  const primaryId = `standhere-${identifier.sessionKey}-a`;
  peer = new Peer(primaryId);

  peer.on("open", () => {
    // We got the "a" slot first — wait for the other phone to connect to us.
  });

  peer.on("connection", (incomingConn) => {
    conn = incomingConn;
    wireConnection();
  });

  peer.on("error", (err) => {
    if (err && err.type === "unavailable-id") {
      // Someone already claimed the "a" slot — we're the second phone.
      becomeSecondPeer(primaryId);
    } else if (err && err.type === "peer-unavailable") {
      showRuntimeError("Couldn't find the other phone yet — make sure they've also tapped Start with the same location.");
    } else {
      showRuntimeError("Connection problem (" + (err && err.type ? err.type : "unknown") + "). Check your internet connection.");
    }
  });

  directionsTimer = setInterval(pollRealDirections, DIRECTIONS_POLL_MS);
}

function becomeSecondPeer(primaryId) {
  try { peer.destroy(); } catch (e) {}
  peer = new Peer();
  peer.on("open", () => {
    conn = peer.connect(primaryId, { reliable: true });
    wireConnection();
  });
  peer.on("error", (err2) => {
    showRuntimeError("Connection problem (" + (err2 && err2.type ? err2.type : "unknown") + "). Check your internet connection.");
  });
}

function wireConnection() {
  conn.on("open", () => {
    hideRuntimeError();
    sendMyLocationIfKnown();
  });
  conn.on("data", (data) => {
    if (data && typeof data.lat === "number" && typeof data.lng === "number") {
      otherLocation = { lat: data.lat, lng: data.lng };
      recompute();
    }
  });
  conn.on("close", () => {
    otherLocation = null;
    showRuntimeError("The other phone disconnected.");
    recompute();
  });
  conn.on("error", () => {
    showRuntimeError("Lost the connection to the other phone.");
  });
}

function sendMyLocationIfKnown() {
  if (conn && conn.open && myLocation) {
    conn.send({ lat: myLocation.lat, lng: myLocation.lng });
  }
}

function startOwnGeolocation() {
  if (!(typeof navigator !== "undefined" && navigator.geolocation)) {
    showRuntimeError("Geolocation isn't supported on this device.");
    return;
  }
  myWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      sendMyLocationIfKnown();
      recompute();
    },
    () => {
      showRuntimeError("Location unavailable — check permissions and try again.");
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

async function pollRealDirections() {
  if (!myLocation || !otherLocation) return;
  const result = await fetchWalkingRoute(myLocation.lat, myLocation.lng, otherLocation.lat, otherLocation.lng);
  if (result) {
    routeInfo = result;
    render();
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function recompute() {
  if (mode === "live") {
    if (myLocation && otherLocation) {
      liveDistanceMeters = haversineMeters(myLocation.lat, myLocation.lng, otherLocation.lat, otherLocation.lng);
    } else {
      liveDistanceMeters = null;
    }
  }
  updateAppState();
  render();
}

function updateAppState() {
  const d = mode === "demo" ? demoOtherDistance : liveDistanceMeters;

  if (d == null) {
    appState = "SEARCHING";
    return;
  }
  const wasMatched = appState === "MATCHED";
  if (d <= ARRIVE_M) {
    if (!wasMatched) {
      triggerVibration([120, 90, 120, 90, 120]); // three short pulses, matching the three-beep chime
      playMatchChime();
    }
    appState = "MATCHED";
  } else if (d <= CLOSE_M) {
    appState = "CLOSE";
  } else {
    appState = "FAR";
  }
}

function triggerVibration(pattern) {
  try {
    if (vibrationSupported && navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Demo mode controls
// ---------------------------------------------------------------------------

el.btnSimulateApproach.addEventListener("click", () => {
  demoOtherDistance = Math.max(0, demoOtherDistance - 190);
  updateAppState();
  render();
  if (demoOtherDistance <= 0) {
    el.btnSimulateApproach.classList.add("hidden");
    el.btnResetDemo.classList.remove("hidden");
  }
});

el.btnResetDemo.addEventListener("click", () => {
  demoOtherDistance = 640;
  appState = "FAR";
  el.btnSimulateApproach.classList.remove("hidden");
  el.btnResetDemo.classList.add("hidden");
  render();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showRuntimeError(msg) {
  el.errorBlock.textContent = msg;
  el.errorBlock.classList.remove("hidden");
}
function hideRuntimeError() {
  el.errorBlock.classList.add("hidden");
}

function render() {
  const d = mode === "demo" ? demoOtherDistance : liveDistanceMeters;
  const glowActive = appState === "MATCHED";

  el.glow.classList.toggle("active", glowActive);
  if (glowActive) {
    el.glow.style.background =
      `radial-gradient(circle at 50% 38%, ${identifier.colorHex}55, transparent 62%)`;
    el.glow.style.boxShadow = `inset 0 0 140px 18px ${identifier.colorHex}77`;
  }

  const headlineMap = {
    SEARCHING: "LOOKING FOR THE OTHER PHONE…",
    FAR: "ON THE WAY",
    CLOSE: "GETTING CLOSE",
    MATCHED: "YOU'VE FOUND EACH OTHER"
  };
  el.headline.textContent = headlineMap[appState];

  const showBigDistance = appState === "FAR" || appState === "CLOSE";
  el.bigDistanceBlock.classList.toggle("hidden", !showBigDistance && appState !== "SEARCHING");
  if (appState === "SEARCHING") {
    el.bigDistance.textContent = "—";
    el.subDistance.textContent = mode === "live"
      ? "Open this same link on the other phone and type the same location."
      : "";
  } else {
    el.bigDistance.textContent = formatDistance(d);
    if (routeInfo && mode === "live") {
      const mins = Math.max(1, Math.round(routeInfo.seconds / 60));
      el.subDistance.textContent = `${mins} min walk · ${formatDistance(routeInfo.meters)} by route`;
    } else {
      el.subDistance.textContent = "straight-line distance";
    }
  }

  const showBadge = appState === "MATCHED";
  el.badgeBlock.classList.toggle("hidden", !showBadge);
  if (showBadge) {
    paintBadge(el.matchBadge, identifier);
  }
}

render();
