"use client";

// OpenStreetMap view of Teltonika devices. Uses raw Leaflet (no react-leaflet)
// inside useEffect so it only runs client-side (Leaflet needs `window`).
// Polls /api/positions every 2s and keeps one marker per IMEI (latest position).

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";

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

function popupHtml(p: Position): string {
  const when = new Date(p.timestamp).toLocaleString();
  return (
    `<div style="font:13px/1.5 system-ui,sans-serif">` +
    `<b>IMEI:</b> ${p.imei}<br/>` +
    `<b>Konum:</b> ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}<br/>` +
    `<b>Hız:</b> ${p.speed} km/h &nbsp; <b>Uydu:</b> ${p.satellites}<br/>` +
    `<b>Zaman:</b> ${when}` +
    `</div>`
  );
}

export default function MapView() {
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const centeredRef = useRef(false);
  const [positions, setPositions] = useState<Position[]>([]);

  // Pan/zoom the map to a device and open its popup.
  function focusDevice(imei: string) {
    const map = mapRef.current;
    const marker = markersRef.current.get(imei);
    if (!map || !marker) return;
    map.setView(marker.getLatLng(), 16, { animate: true });
    marker.openPopup();
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let resizeObserver: ResizeObserver | undefined;

    // Leaflet is imported dynamically so it never runs during SSR.
    import("leaflet").then((L) => {
      if (cancelled) return;

      const map = L.map("map").setView([39.0, 35.0], 6); // Turkey overview
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      // Leaflet caches the container size at init; if the layout wasn't settled
      // yet it renders tiles for a wrong (small) size. Recompute on any resize.
      const el = document.getElementById("map");
      if (el) {
        resizeObserver = new ResizeObserver(() => map.invalidateSize());
        resizeObserver.observe(el);
      }
      map.invalidateSize();

      // Simple built-in pin (avoids bundler issues with Leaflet's default icon).
      const icon = L.divIcon({
        className: "",
        html:
          '<div style="width:16px;height:16px;border-radius:50% 50% 50% 0;' +
          "background:#e11d48;border:2px solid #fff;transform:rotate(-45deg);" +
          'box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
        popupAnchor: [0, -10],
      });

      async function refresh() {
        try {
          const res = await fetch("/api/positions", { cache: "no-store" });
          const data: { positions: Position[] } = await res.json();
          if (cancelled) return;

          for (const p of data.positions) {
            const existing = markersRef.current.get(p.imei);
            if (existing) {
              existing.setLatLng([p.lat, p.lon]);
              existing.setPopupContent(popupHtml(p));
            } else {
              const m = L.marker([p.lat, p.lon], { icon })
                .addTo(map)
                .bindPopup(popupHtml(p));
              markersRef.current.set(p.imei, m);
            }
          }
          setPositions(data.positions);

          // Center on the first device we ever see.
          if (!centeredRef.current && data.positions.length > 0) {
            const p = data.positions[0];
            map.setView([p.lat, p.lon], 15);
            centeredRef.current = true;
          }
        } catch {
          // network hiccup — keep the last state, try again next tick
        }
      }

      refresh();
      timer = setInterval(refresh, 2000);
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
      centeredRef.current = false;
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div id="map" style={{ position: "absolute", inset: 0, background: "#ddd" }} />
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 1000,
          width: 260,
          maxHeight: "calc(100vh - 16px)",
          overflowY: "auto",
          background: "rgba(255,255,255,.95)",
          color: "#111",
          borderRadius: 8,
          font: "13px system-ui,sans-serif",
          boxShadow: "0 1px 6px rgba(0,0,0,.3)",
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            fontWeight: 600,
            borderBottom: "1px solid #eee",
            position: "sticky",
            top: 0,
            background: "rgba(255,255,255,.95)",
          }}
        >
          {positions.length > 0
            ? `${positions.length} cihaz`
            : "Cihaz bekleniyor…"}
        </div>
        {[...positions]
          .sort((a, b) => b.timestamp - a.timestamp)
          .map((p) => (
          <button
            key={p.imei}
            onClick={() => focusDevice(p.imei)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              border: "none",
              borderBottom: "1px solid #f0f0f0",
              background: "transparent",
              cursor: "pointer",
              font: "inherit",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "#f3f4f6")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <div style={{ fontWeight: 600, fontFamily: "monospace" }}>
              {p.imei}
            </div>
            <div style={{ color: "#555", fontSize: 12 }}>
              {p.lat.toFixed(5)}, {p.lon.toFixed(5)} · {p.speed} km/h
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
