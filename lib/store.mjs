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

// A record's own timestamp is only trustworthy inside a plausible range. A
// device with no GPS fix or an unsynced clock can emit garbage (epoch 0, or a
// far-future date). Such a value must never be compared against, otherwise one
// bogus future fix would make every later real record look "older" and the
// device would be locked out forever.
const MIN_TS = Date.UTC(2000, 0, 1);
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 1 day of clock skew

function isSaneTimestamp(ts, now) {
  return typeof ts === "number" && ts >= MIN_TS && ts <= now + FUTURE_TOLERANCE_MS;
}

// Insert or update a device's position, preferring the record with the newest
// timestamp FROM THE DATA (pos.timestamp = GPS fix time) rather than the
// arrival time — devices replay buffered older records after newer ones, and
// those must not overwrite a fresher fix.
//
// The fix-time comparison is only applied when BOTH timestamps are sane; if
// either is bogus we fall back to arrival order so a bad device clock can never
// permanently block updates. Returns true if stored, false if skipped as stale.
export function upsert(imei, pos) {
  const map = getMap();
  const now = Date.now();
  const existing = map.get(imei);

  if (
    existing &&
    isSaneTimestamp(existing.timestamp, now) &&
    isSaneTimestamp(pos.timestamp, now) &&
    existing.timestamp > pos.timestamp
  ) {
    return false; // we already hold a newer fix
  }

  map.set(imei, { imei, ...pos, updatedAt: now });
  return true;
}

// Return all known devices' latest positions as a plain array.
export function list() {
  return Array.from(getMap().values());
}
