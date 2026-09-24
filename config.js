// ---------------------------------------------------------------------------
// STAND HERE — configuration
//
// Live Mode (real two-phone matching) needs NO setup here — it connects the
// two phones directly over WebRTC using PeerJS's free public broker, no
// account or key required. Demo Mode also needs nothing.
//
// The only optional thing below is Mapbox, for real walking distance/ETA
// instead of a straight line. Everything works without it.
// ---------------------------------------------------------------------------

window.STAND_HERE_CONFIG = {
  // --- Mapbox Directions API (optional) ---
  // Create a free account at https://account.mapbox.com and copy your
  // default public token (starts with "pk."). Leave blank to skip real
  // walking routes and just use straight-line distance, which is fine for
  // a classroom demo.
  mapboxToken: "",

  // --- Tuning ---
  closeThresholdMeters: 150,   // when the interface starts simplifying
  arrivalThresholdMeters: 25,  // when it counts as a confirmed match
  directionsPollMs: 20000      // how often to call the optional directions API
};
