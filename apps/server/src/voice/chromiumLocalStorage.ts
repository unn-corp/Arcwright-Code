// Read-only LevelDB decoding: https://github.com/google/leveldb/tree/main/doc
// Opening the user's live database with a LevelDB client would contend for its lock.
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  take(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.length)
      throw new Error("Truncated LevelDB data");
    const result = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  number(size: number): number {
    return this.take(size).reduce((value, byte, index) => value + byte * 2 ** (8 * index), 0);
  }
  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 56; shift += 7) {
      const byte = this.number(1);
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(value)) throw new Error("Oversized LevelDB integer");
        return value;
      }
    }
    throw new Error("Invalid LevelDB integer");
  }
  string(): Uint8Array {
    return this.take(this.varint());
  }
}

function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  crc = ~crc >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function logRecords(bytes: Uint8Array): Uint8Array[] {
  const reader = new Reader(bytes);
  const records: Uint8Array[] = [];
  let fragments: Uint8Array[] | null = null;
  while (reader.offset + 7 <= bytes.length) {
    const remaining = 32768 - (reader.offset % 32768);
    if (remaining < 7) {
      reader.take(remaining);
      continue;
    }
    const crc = reader.number(4),
      size = reader.number(2),
      type = reader.number(1);
    if (!type && !size) continue;
    // An active writer may not have finished the final physical record.
    if (reader.offset + size > bytes.length) break;
    if (size + 7 > remaining) throw new Error("Invalid LevelDB log block");
    const payload = reader.take(size);
    if (checksum(Uint8Array.of(type, ...payload)) !== crc)
      throw new Error("Invalid LevelDB checksum");
    if (type === 1) {
      records.push(payload);
      fragments = null;
    } else if (type === 2) fragments = [payload];
    else if (type === 3 && fragments) fragments.push(payload);
    else if (type === 4 && fragments) {
      records.push(Buffer.concat([...fragments, payload]));
      fragments = null;
    } else throw new Error("Invalid LevelDB log fragment");
  }
  return records;
}

/** Only manifest-referenced tables and current logs may contribute values or tombstones. */
export function chromiumStorageFiles(manifest: Uint8Array, names: readonly string[]): string[] {
  const tables = new Set<number>();
  let log = 0,
    previousLog = 0;
  for (const record of logRecords(manifest)) {
    const reader = new Reader(record);
    while (reader.offset < record.length) {
      const tag = reader.varint();
      if (tag === 1) reader.string();
      else if (tag === 2) log = reader.varint();
      else if (tag === 9) previousLog = reader.varint();
      else if (tag === 3 || tag === 4) reader.varint();
      else if (tag === 5) {
        reader.varint();
        reader.string();
      } else if (tag === 6) {
        reader.varint();
        tables.delete(reader.varint());
      } else if (tag === 7) {
        reader.varint();
        tables.add(reader.varint());
        reader.varint();
        reader.string();
        reader.string();
      } else throw new Error("Unsupported LevelDB manifest");
    }
  }
  const presentTables = new Set<number>();
  const selected = names.filter((name) => {
    const match = /^(\d+)\.(log|ldb|sst)$/.exec(name);
    if (!match) return false;
    const number = Number(match[1]);
    if (match[2] === "log") return number >= log || number === previousLog;
    presentTables.add(number);
    return tables.has(number);
  });
  if ([...tables].some((number) => !presentTables.has(number)))
    throw new Error("Missing live LevelDB table");
  return selected;
}

function unsnappy(bytes: Uint8Array): Uint8Array {
  const reader = new Reader(bytes),
    size = reader.varint();
  if (size > MAX_BLOCK_BYTES) throw new Error("Oversized Snappy block");
  const output = new Uint8Array(size);
  let position = 0;
  while (reader.offset < bytes.length) {
    const tag = reader.number(1),
      type = tag & 3;
    let length = tag >>> 2;
    if (type === 0) {
      length = length < 60 ? length + 1 : reader.number(length - 59) + 1;
      if (position + length > size) throw new Error("Invalid Snappy literal");
      output.set(reader.take(length), position);
      position += length;
    } else {
      const offset =
        type === 1 ? ((tag & 224) << 3) + reader.number(1) : reader.number(type === 2 ? 2 : 4);
      length = type === 1 ? 4 + ((tag >>> 2) & 7) : length + 1;
      if (!offset || offset > position || position + length > size)
        throw new Error("Invalid Snappy copy");
      for (let i = 0; i < length; i++) {
        output[position] = output[position - offset]!;
        position++;
      }
    }
  }
  if (position !== size) throw new Error("Truncated Snappy block");
  return output;
}

function blockEntries(bytes: Uint8Array): Array<readonly [Uint8Array, Uint8Array]> {
  if (bytes.length < 4) throw new Error("Truncated LevelDB block");
  const restarts = new Reader(bytes.subarray(bytes.length - 4)).number(4);
  const end = bytes.length - 4 - restarts * 4;
  if (end < 0) throw new Error("Invalid LevelDB restart array");
  const reader = new Reader(bytes.subarray(0, end));
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [];
  let previous = new Uint8Array();
  while (reader.offset < end) {
    const shared = reader.varint(),
      added = reader.varint(),
      size = reader.varint();
    if (shared > previous.length) throw new Error("Invalid LevelDB key prefix");
    const key = Buffer.concat([previous.subarray(0, shared), reader.take(added)]);
    entries.push([key, reader.take(size)]);
    previous = key;
  }
  return entries;
}

function tableEntries(bytes: Uint8Array): Array<readonly [Uint8Array, Uint8Array]> {
  if (
    bytes.length < 48 ||
    Buffer.from(bytes.subarray(-8)).readBigUInt64LE() !== 0xdb4775248b80fb57n
  )
    throw new Error("Invalid LevelDB table");
  const footer = new Reader(bytes.subarray(-48));
  footer.varint();
  footer.varint();
  const readBlock = (handle: Reader) => {
    const offset = handle.varint(),
      size = handle.varint();
    if (size > MAX_BLOCK_BYTES || offset + size + 5 > bytes.length - 48)
      throw new Error("Invalid LevelDB block handle");
    const reader = new Reader(bytes.subarray(offset));
    const raw = reader.take(size),
      type = reader.number(1),
      crc = reader.number(4);
    if (checksum(bytes.subarray(offset, offset + size + 1)) !== crc)
      throw new Error("Invalid table checksum");
    if (type !== 0 && type !== 1) throw new Error("Unsupported table compression");
    return type ? unsnappy(raw) : raw;
  };
  return blockEntries(readBlock(footer)).flatMap(([, handle]) =>
    blockEntries(readBlock(new Reader(handle))),
  );
}

/** Reads only the native app's file-origin preferences, choosing the latest sequence across WAL and SST. */
export function decodeChromiumLocalStorage(
  files: ReadonlyMap<string, Uint8Array>,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const records = new Map<string, { sequence: bigint; value: Uint8Array | null }>();
  const apply = (key: Uint8Array, value: Uint8Array | null, sequence: bigint) => {
    const originEnd = key.indexOf(0);
    if (Buffer.from(key.subarray(0, originEnd)).toString() !== "_file://") return;
    const encoded = key.subarray(originEnd + 1);
    const name = Buffer.from(encoded.subarray(1)).toString(encoded[0] === 0 ? "utf16le" : "latin1");
    if (keys.has(name) && (!records.has(name) || records.get(name)!.sequence < sequence))
      records.set(name, { sequence, value });
  };
  for (const [name, bytes] of files) {
    if (name.endsWith(".log")) {
      for (const batch of logRecords(bytes)) {
        const reader = new Reader(batch);
        const sequence = Buffer.from(reader.take(8)).readBigUInt64LE(),
          count = reader.number(4);
        if (count > batch.length) throw new Error("Invalid LevelDB batch");
        for (let i = 0; i < count; i++) {
          const type = reader.number(1),
            key = reader.string();
          if (type !== 0 && type !== 1) throw new Error("Invalid LevelDB operation");
          apply(key, type ? reader.string() : null, sequence + BigInt(i));
        }
        if (reader.offset !== batch.length) throw new Error("Invalid LevelDB batch length");
      }
    } else {
      for (const [key, value] of tableEntries(bytes)) {
        if (key.length < 8) throw new Error("Invalid LevelDB internal key");
        const tag = Buffer.from(key.subarray(-8)).readBigUInt64LE();
        if ((tag & 255n) > 1n) throw new Error("Unsupported LevelDB value");
        apply(key.subarray(0, -8), tag & 255n ? value : null, tag >> 8n);
      }
    }
  }
  return new Map(
    [...records].flatMap(([key, { value }]) =>
      value
        ? [[key, Buffer.from(value.subarray(1)).toString(value[0] === 0 ? "utf16le" : "latin1")]]
        : [],
    ),
  );
}
