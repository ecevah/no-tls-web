// Sahte Teltonika cihazı — local PC'den uzaktaki sunucuyu test etmek için.
//
// Kullanım:
//   1) Aşağıdaki HOST'u kendi sunucu IP'nle değiştir.
//   2) node test-device.mjs
//      veya IP/koordinatı komut satırından ver:
//      node test-device.mjs 100.119.84.40 41.0082 28.9784
//
// Bu dosya bağımsızdır (repo'daki hiçbir şeyi import etmez), istediğin yere
// kopyalayıp çalıştırabilirsin. Sadece Node.js gerekir.

import net from "node:net";

// ---- AYARLAR (burayı kendine göre değiştir) ----
const HOST = process.argv[2] || "100.119.84.40"; // sunucu IP'si
const PORT = Number(process.env.TCP_PORT || 5027); // Teltonika TCP portu
const IMEI = "350612345678901";                    // test IMEI'si
const LAT = Number(process.argv[3] || 41.0082);    // enlem (default: İstanbul)
const LON = Number(process.argv[4] || 28.9784);    // boylam
const SPEED = 42;                                   // km/h
// -------------------------------------------------

// Teltonika CRC-16/IBM (poly 0xA001)
function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

function buildImeiPacket(imei) {
  const body = Buffer.from(imei, "ascii");
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function buildAvlPacket(lat, lon, speed) {
  const tsGps = Buffer.alloc(24);
  let o = 0;
  tsGps.writeBigUInt64BE(BigInt(Date.now()), o); o += 8;   // timestamp (ms)
  tsGps.writeUInt8(1, o); o += 1;                           // priority
  tsGps.writeInt32BE(Math.round(lon * 1e7), o); o += 4;     // longitude
  tsGps.writeInt32BE(Math.round(lat * 1e7), o); o += 4;     // latitude
  tsGps.writeInt16BE(100, o); o += 2;                       // altitude
  tsGps.writeUInt16BE(0, o); o += 2;                        // angle
  tsGps.writeUInt8(12, o); o += 1;                          // satellites
  tsGps.writeUInt16BE(speed, o); o += 2;                    // speed

  const dataField = Buffer.concat([
    Buffer.from([0x08]),                        // codec id (Codec 8)
    Buffer.from([0x01]),                        // number of data 1
    tsGps,                                      // ts + priority + gps
    Buffer.from([0, 0, 0, 0, 0, 0]),            // io: event,total,N1,N2,N4,N8 = 0
    Buffer.from([0x01]),                        // number of data 2
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0, 0);                   // preamble
  header.writeUInt32BE(dataField.length, 4);    // data field length
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16(dataField), 0);
  return Buffer.concat([header, dataField, crc]);
}

console.log(`→ ${HOST}:${PORT} adresine bağlanılıyor...`);
const timeout = setTimeout(() => {
  console.error("✗ zaman aşımı (10s) — port/firewall'ı kontrol et");
  socket.destroy();
  process.exit(1);
}, 10000);

const socket = net.connect(PORT, HOST, () => {
  console.log(`✓ bağlandı, IMEI gönderiliyor: ${IMEI}`);
  socket.write(buildImeiPacket(IMEI));
});

let phase = "login";
socket.on("data", (buf) => {
  if (phase === "login") {
    if (buf[0] === 0x01) {
      console.log("✓ login kabul edildi (0x01), AVL paketi gönderiliyor");
      console.log(`  konum: ${LAT}, ${LON}  hız: ${SPEED} km/h`);
      socket.write(buildAvlPacket(LAT, LON, SPEED));
      phase = "data";
    } else {
      console.error("✗ login reddedildi:", buf);
      socket.end();
    }
  } else {
    console.log(`✓ sunucu ${buf.readUInt32BE(0)} kayıt onayladı. Tamam.`);
    console.log(`→ Şimdi tarayıcıda http://${HOST}:3111 adresine bak.`);
    socket.end();
  }
});

socket.on("error", (e) => { clearTimeout(timeout); console.error("✗ bağlantı hatası:", e.message); });
socket.on("close", () => { clearTimeout(timeout); console.log("bağlantı kapandı"); });
