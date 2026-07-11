// In-memory store of the latest position per device (keyed by IMEI).
//
// The raw-TCP listener (server.mjs) and the Next.js route handler
// (app/api/positions/route.ts) run in the SAME Node process but are bundled
// separately, so a normal module import would give them two different Map
// instances. Anchoring the Map on `globalThis` guarantees a single shared
// instance across both. Not persisted — resets on server restart.

/** @typedef {{ imei: string, lat: number, lon: number, altitude: number,
 *  angle: number, satellites: number, speed: number, timestamp: number,
 *  updatedAt: number }} Position */

/** @returns {Map<string, Position>} */
function getMap() {
  if (!globalThis.__teltonikaStore) {
    globalThis.__teltonikaStore = new Map();
  }
  return globalThis.__teltonikaStore;
}

// Insert or update the latest position for a device.
export function upsert(imei, pos) {
  getMap().set(imei, { imei, ...pos, updatedAt: Date.now() });
}

// Return all known devices' latest positions as a plain array.
export function list() {
  return Array.from(getMap().values());
}
