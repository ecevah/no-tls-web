// Fake Teltonika device — tests the whole pipeline without hardware.
//
// Connects to the TCP listener, performs the IMEI login, sends one Codec 8 AVL
// packet with a sample coordinate, and verifies the server's acks.
//
//   node lib/simulate.mjs               -> default IMEI, Istanbul coordinate
//   node lib/simulate.mjs 350612345678901 41.0082 28.9784 90
//
// Args: [imei] [lat] [lon] [speed]

import net from 'net';
import { crc16 } from './teltonika.mjs';

const [, , imeiArg, latArg, lonArg, speedArg] = process.argv;
const IMEI = imeiArg || '350612345678901';
const LAT = latArg ? parseFloat(latArg) : 41.0082; // Istanbul
const LON = lonArg ? parseFloat(lonArg) : 28.9784;
const SPEED = speedArg ? parseInt(speedArg, 10) : 42;
const HOST = process.env.TCP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.TCP_PORT || '5027', 10);

// --- Build the IMEI login packet: [2B length][ascii imei] ---
function buildImeiPacket(imei) {
  const body = Buffer.from(imei, 'ascii');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// --- Build a Codec 8 AVL packet with a single record and no IO values ---
function buildAvlPacket(lat, lon, speed) {
  // Timestamp + priority + GPS element (15 bytes).
  const tsGps = Buffer.alloc(8 + 1 + 15);
  let o = 0;
  tsGps.writeBigUInt64BE(BigInt(Date.now()), o); o += 8; // timestamp (ms)
  tsGps.writeUInt8(1, o); o += 1;                         // priority
  tsGps.writeInt32BE(Math.round(lon * 1e7), o); o += 4;   // longitude
  tsGps.writeInt32BE(Math.round(lat * 1e7), o); o += 4;   // latitude
  tsGps.writeInt16BE(100, o); o += 2;                     // altitude
  tsGps.writeUInt16BE(0, o); o += 2;                      // angle
  tsGps.writeUInt8(12, o); o += 1;                        // satellites
  tsGps.writeUInt16BE(speed, o); o += 2;                  // speed

  const dataField = Buffer.concat([
    Buffer.from([0x08]),            // codec id (Codec 8)
    Buffer.from([0x01]),            // number of data 1
    tsGps,                          // the record's ts + priority + gps
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // io: event,total,N1,N2,N4,N8 = 0
    Buffer.from([0x01]),            // number of data 2
  ]);

  const header = Buffer.alloc(8);
  header.writeUInt32BE(0, 0);               // preamble
  header.writeUInt32BE(dataField.length, 4); // data field length
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(dataField), 0);

  return Buffer.concat([header, dataField, crc]);
}

const socket = net.connect(PORT, HOST, () => {
  console.log(`connected to ${HOST}:${PORT}, sending IMEI ${IMEI}`);
  socket.write(buildImeiPacket(IMEI));
});

let phase = 'login';
socket.on('data', (buf) => {
  if (phase === 'login') {
    if (buf[0] === 0x01) {
      console.log('✓ login accepted (0x01), sending AVL packet');
      socket.write(buildAvlPacket(LAT, LON, SPEED));
      phase = 'data';
    } else {
      console.error('✗ login rejected:', buf);
      socket.end();
    }
  } else if (phase === 'data') {
    const accepted = buf.readUInt32BE(0);
    console.log(`✓ server acked ${accepted} record(s). Done.`);
    socket.end();
  }
});

socket.on('error', (err) => console.error('socket error:', err.message));
socket.on('close', () => console.log('connection closed'));
