// Teltonika Codec 8 / Codec 8 Extended TCP protocol parser.
//
// Framework-agnostic pure functions. Used by the raw-TCP listener in server.mjs.
// Reference: https://wiki.teltonika-gps.com/view/Codec
//
// Wire flow (plain TCP, no TLS):
//   1. Device connects, sends IMEI:  [2B length][IMEI ASCII]
//   2. Server replies 1 byte: 0x01 accept, 0x00 reject
//   3. Device sends AVL packet(s): preamble(4)=0 | dataLen(4) | codecId(1) |
//      count1(1) | records... | count2(1) | crc16(4)
//   4. Server replies 4 bytes big-endian = number of accepted records
//
// TCP is a stream: a chunk may hold a partial or several packets. The parsers
// below return null when there aren't enough bytes yet (caller keeps buffering),
// otherwise return how many bytes were consumed so the caller can slice them off.

const CODEC_8 = 0x08;
const CODEC_8_EXT = 0x8e;

// CRC-16/IBM (a.k.a. ARC): poly 0xA001, reflected, init 0x0000.
// Teltonika computes it over Codec ID .. Number of Data 2 (the data field).
export function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

// Parse the IMEI login packet.
// Returns { imei, bytesConsumed } or null if not enough bytes yet.
export function parseImeiPacket(buf) {
  if (buf.length < 2) return null;
  const len = buf.readUInt16BE(0);
  // Sanity: Teltonika IMEIs are 15 digits. Guard against a mis-framed stream.
  if (len === 0 || len > 20) {
    throw new Error(`Invalid IMEI length field: ${len}`);
  }
  if (buf.length < 2 + len) return null;
  const imei = buf.toString('ascii', 2, 2 + len);
  return { imei, bytesConsumed: 2 + len };
}

// Parse one AVL data packet (may contain multiple records).
// Returns { records, count, bytesConsumed } or null if the full packet
// hasn't arrived yet. Throws on a structurally invalid packet.
export function parseAvlPacket(buf) {
  // Need at least preamble(4) + dataLen(4) to know the total size.
  if (buf.length < 8) return null;

  const preamble = buf.readUInt32BE(0);
  if (preamble !== 0) {
    throw new Error(`Invalid preamble: ${preamble} (expected 0)`);
  }

  const dataLen = buf.readUInt32BE(4);
  const totalLen = 8 + dataLen + 4; // preamble + dataLenField + data + crc
  if (buf.length < totalLen) return null; // wait for more bytes

  const data = buf.subarray(8, 8 + dataLen); // Codec ID .. Number of Data 2
  const crcExpected = buf.readUInt32BE(8 + dataLen);
  const crcActual = crc16(data);
  if ((crcExpected & 0xffff) !== crcActual) {
    throw new Error(
      `CRC mismatch: got 0x${crcExpected.toString(16)}, computed 0x${crcActual.toString(16)}`,
    );
  }

  const codecId = data.readUInt8(0);
  if (codecId !== CODEC_8 && codecId !== CODEC_8_EXT) {
    throw new Error(`Unsupported codec: 0x${codecId.toString(16)}`);
  }
  const extended = codecId === CODEC_8_EXT;

  const count1 = data.readUInt8(1);
  const records = [];
  let off = 2; // start of first AVL record within `data`

  for (let i = 0; i < count1; i++) {
    const rec = parseAvlRecord(data, off, extended);
    records.push(rec.record);
    off = rec.nextOffset;
  }

  const count2 = data.readUInt8(off);
  if (count2 !== count1) {
    throw new Error(`Record count mismatch: ${count1} vs ${count2}`);
  }

  return { records, count: count1, bytesConsumed: totalLen };
}

// Parse a single AVL record starting at `off` within the data buffer.
// Returns { record, nextOffset }.
function parseAvlRecord(data, off, extended) {
  const timestamp = Number(data.readBigUInt64BE(off));
  off += 8;
  const priority = data.readUInt8(off);
  off += 1;

  // GPS element (15 bytes): lon(4) lat(4) alt(2) angle(2) sat(1) speed(2)
  const lon = data.readInt32BE(off) / 1e7;
  off += 4;
  const lat = data.readInt32BE(off) / 1e7;
  off += 4;
  const altitude = data.readInt16BE(off);
  off += 2;
  const angle = data.readUInt16BE(off);
  off += 2;
  const satellites = data.readUInt8(off);
  off += 1;
  const speed = data.readUInt16BE(off);
  off += 2;

  // IO element — parsed only to advance the offset correctly. Values unused.
  off = skipIoElement(data, off, extended);

  return {
    record: {
      timestamp,
      priority,
      lat,
      lon,
      altitude,
      angle,
      satellites,
      speed,
    },
    nextOffset: off,
  };
}

// Advance past the IO element. In Codec 8 the event id and counters are 1 byte;
// in Codec 8 Extended they are 2 bytes and there is an extra variable-length
// (NX) block. Returns the offset just after the IO element.
function skipIoElement(data, off, extended) {
  const idSize = extended ? 2 : 1;
  const readId = extended
    ? () => {
        const v = data.readUInt16BE(off);
        off += 2;
        return v;
      }
    : () => {
        const v = data.readUInt8(off);
        off += 1;
        return v;
      };
  const readCount = readId; // same width as the id field

  readId(); // event IO id (unused)
  readCount(); // total IO count (unused; we walk each sized block instead)

  // Fixed-width blocks: N1 (1B values), N2 (2B), N4 (4B), N8 (8B).
  for (const valueSize of [1, 2, 4, 8]) {
    const n = readCount();
    off += n * (idSize + valueSize);
  }

  // Codec 8 Extended only: NX block — each entry is id + 2B length + value.
  if (extended) {
    const nx = data.readUInt16BE(off);
    off += 2;
    for (let i = 0; i < nx; i++) {
      off += idSize; // io id
      const vlen = data.readUInt16BE(off);
      off += 2;
      off += vlen;
    }
  }

  return off;
}
