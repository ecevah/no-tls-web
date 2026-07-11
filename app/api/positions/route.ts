// Returns the latest known position of every device as JSON.
// The browser polls this every couple of seconds to update the map.
//
// The TCP listener (server.mjs) writes positions into a Map anchored on
// globalThis (see lib/store.mjs). We read that same Map here directly, which
// sidesteps the fact that the custom server and Next's bundled route handlers
// don't share module instances.

export const dynamic = 'force-dynamic'; // never cache — always live

type Position = {
  imei: string;
  lat: number;
  lon: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
  timestamp: number;
  updatedAt: number;
};

export async function GET() {
  const store = (globalThis as { __teltonikaStore?: Map<string, Position> })
    .__teltonikaStore;
  const positions = store ? Array.from(store.values()) : [];
  return Response.json({ positions });
}
