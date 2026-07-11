// Custom Next.js server + raw TCP listener for Teltonika FMC devices.
//
// One Node process runs BOTH:
//   - the Next.js HTTP app (web UI + /api/positions), on PORT (default 3000)
//   - a plain TCP server (no TLS, no mTLS), on TCP_PORT (default 5027), which
//     speaks the Teltonika Codec 8 / 8E protocol and stores each device's
//     latest position in the shared globalThis store.
//
// This file is NOT processed by the Next.js compiler (see custom-server docs),
// so it is plain Node ESM.

import { createServer } from 'http';
import net from 'net';
import next from 'next';
import { parseImeiPacket, parseAvlPacket } from './lib/teltonika.mjs';
import { upsert } from './lib/store.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3111', 10);
const tcpPort = parseInt(process.env.TCP_PORT || '5027', 10);

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // --- HTTP (Next.js) ---
  createServer((req, res) => handle(req, res)).listen(port, () => {
    console.log(`> Web ready on http://localhost:${port} (${dev ? 'dev' : 'prod'})`);
  });

  // --- TCP (Teltonika devices) ---
  startTcpServer(tcpPort);
});

function startTcpServer(listenPort) {
  const server = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[tcp] device connected: ${peer}`);

    // Per-connection state: buffer of unparsed bytes + protocol phase.
    let buffer = Buffer.alloc(0);
    let imei = null; // null until the login packet is accepted

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        // Phase 1: IMEI login (once per connection).
        if (imei === null) {
          const login = parseImeiPacket(buffer);
          if (!login) return; // wait for more bytes
          imei = login.imei;
          buffer = buffer.subarray(login.bytesConsumed);
          socket.write(Buffer.from([0x01])); // accept
          console.log(`[tcp] ${peer} IMEI ${imei} accepted`);
          // fall through: buffer may already contain an AVL packet
        }

        // Phase 2: AVL data packets (possibly several buffered together).
        while (buffer.length > 0) {
          const parsed = parseAvlPacket(buffer);
          if (!parsed) break; // incomplete packet, wait for more
          buffer = buffer.subarray(parsed.bytesConsumed);

          for (const rec of parsed.records) {
            upsert(imei, rec);
            console.log(
              `[tcp] ${imei} @ ${rec.lat.toFixed(6)},${rec.lon.toFixed(6)} ` +
                `spd=${rec.speed} sat=${rec.satellites}`,
            );
          }

          // Acknowledge: 4-byte big-endian count of accepted records.
          const ack = Buffer.alloc(4);
          ack.writeUInt32BE(parsed.count, 0);
          socket.write(ack);
        }
      } catch (err) {
        console.error(`[tcp] ${peer} parse error: ${err.message} — closing`);
        socket.destroy();
      }
    });

    socket.on('error', (err) => {
      console.error(`[tcp] ${peer} socket error: ${err.message}`);
    });
    socket.on('close', () => {
      console.log(`[tcp] device disconnected: ${peer}${imei ? ` (${imei})` : ''}`);
    });
  });

  server.on('error', (err) => {
    console.error(`[tcp] server error: ${err.message}`);
  });
  server.listen(listenPort, () => {
    console.log(`> TCP listening on :${listenPort} (Teltonika Codec 8/8E, plain TCP)`);
  });
}
