function integer(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
const string = (value: Uint8Array) => Buffer.concat([integer(value.length), value]);
const fixed = (value: number, size: number) => {
  const bytes = Buffer.alloc(size);
  bytes.writeUIntLE(value, 0, size);
  return bytes;
};
const sequence = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
function crc(bytes: Uint8Array): Buffer {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0x82f63b78 : 0);
  }
  value = ~value >>> 0;
  return fixed((((value >>> 15) | (value << 17)) + 0xa282ead8) >>> 0, 4);
}
function log(payload: Uint8Array): Buffer {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const part = payload.subarray(offset, offset + 32761);
    const last = offset + part.length === payload.length;
    const type = offset === 0 ? (last ? 1 : 2) : last ? 4 : 3;
    chunks.push(
      crc(Buffer.concat([Uint8Array.of(type), part])),
      fixed(part.length, 2),
      Uint8Array.of(type),
      part,
    );
    offset += part.length;
  }
  return Buffer.concat(chunks);
}
function key(name: string, origin = "file://"): Buffer {
  return Buffer.from(`_${origin}\0\x01${name}`, "latin1");
}
function value(text: string): Buffer {
  const unicode = [...text].some((character) => (character.codePointAt(0) ?? 0) > 255);
  return Buffer.concat([
    Uint8Array.of(unicode ? 0 : 1),
    Buffer.from(text, unicode ? "utf16le" : "latin1"),
  ]);
}
export function storageLog(
  entries: ReadonlyArray<readonly [string, string | null]>,
  firstSequence = 1,
  origin = "file://",
): Buffer {
  return log(
    Buffer.concat([
      sequence(BigInt(firstSequence)),
      fixed(entries.length, 4),
      ...entries.map(([name, text]) =>
        Buffer.concat([
          Uint8Array.of(text === null ? 0 : 1),
          string(key(name, origin)),
          ...(text === null ? [] : [string(value(text))]),
        ]),
      ),
    ]),
  );
}
export function storageManifest(tables: readonly number[] = [], logNumber = 3): Buffer {
  return log(
    Buffer.concat([
      integer(2),
      integer(logNumber),
      ...tables.map((number) =>
        Buffer.concat([
          integer(7),
          integer(0),
          integer(number),
          integer(100),
          string(new Uint8Array()),
          string(new Uint8Array()),
        ]),
      ),
    ]),
  );
}
function block(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Buffer {
  const encoded: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array();
  for (const [key, value] of entries) {
    let shared = 0;
    while (shared < Math.min(previous.length, key.length) && previous[shared] === key[shared])
      shared++;
    encoded.push(
      integer(shared),
      integer(key.length - shared),
      integer(value.length),
      key.subarray(shared),
      value,
    );
    previous = key;
  }
  return Buffer.concat([...encoded, fixed(0, 4), fixed(1, 4)]);
}
function literal(bytes: Uint8Array): Buffer {
  return bytes.length < 61
    ? Buffer.concat([Uint8Array.of((bytes.length - 1) << 2), bytes])
    : Buffer.concat([Uint8Array.of(61 << 2), fixed(bytes.length - 1, 2), bytes]);
}
function snappy(bytes: Buffer, copyType: 1 | 2 | 4): Buffer {
  const start = bytes.indexOf(Buffer.from("A".repeat(100)));
  if (start < 0) return Buffer.concat([integer(bytes.length), literal(bytes)]);
  const chunks: Uint8Array[] = [integer(bytes.length), literal(bytes.subarray(0, start + 1))];
  let left = 99;
  while (left >= (copyType === 1 ? 4 : 1)) {
    const length = Math.min(left, copyType === 1 ? 11 : 64);
    chunks.push(
      copyType === 1
        ? Uint8Array.of(1 | ((length - 4) << 2), 1)
        : Buffer.concat([
            Uint8Array.of(((length - 1) << 2) | (copyType === 2 ? 2 : 3)),
            fixed(1, copyType),
          ]),
    );
    left -= length;
  }
  if (left) chunks.push(literal(bytes.subarray(start + 100 - left, start + 100)));
  if (start + 100 < bytes.length) chunks.push(literal(bytes.subarray(start + 100)));
  return Buffer.concat(chunks);
}
export function storageTable(
  entries: ReadonlyArray<readonly [string, string | null]>,
  firstSequence = 1,
  compression?: 1 | 2 | 4,
): Buffer {
  const parts: Uint8Array[] = [];
  let position = 0;
  const add = (raw: Buffer, compress = false) => {
    const data = compress && compression ? snappy(raw, compression) : raw;
    const type = compress ? 1 : 0,
      handle = Buffer.concat([integer(position), integer(data.length)]);
    parts.push(data, Uint8Array.of(type), crc(Buffer.concat([data, Uint8Array.of(type)])));
    position += data.length + 5;
    return handle;
  };
  const data = add(
    block(
      entries.map(([name, text], index) => [
        Buffer.concat([
          key(name),
          sequence((BigInt(firstSequence + index) << 8n) | (text === null ? 0n : 1n)),
        ]),
        text === null ? new Uint8Array() : value(text),
      ]),
    ),
    Boolean(compression),
  );
  const meta = add(block([])),
    index = add(block([[Buffer.from("z"), data]]));
  const handles = Buffer.concat([meta, index]);
  const magic = Buffer.alloc(8);
  magic.writeBigUInt64LE(0xdb4775248b80fb57n);
  return Buffer.concat([...parts, handles, Buffer.alloc(40 - handles.length), magic]);
}
