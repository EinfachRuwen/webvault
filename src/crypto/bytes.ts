// Kleine Byte-Helfer. TS 5.7+ unterscheidet Uint8Array<ArrayBuffer> von Uint8Array<ArrayBufferLike>;
// WebCrypto verlangt Ersteres, daher die Cast-Funktion `bs`.

export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });

export type Bytes = Uint8Array<ArrayBuffer>;

/** Als WebCrypto-`BufferSource` verwendbar machen. */
export function bs(data: Uint8Array): Bytes {
  return data as Bytes;
}

export function concat(...parts: Uint8Array[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function xor(a: Uint8Array, b: Uint8Array): Bytes {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

export function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 64-Bit Big-Endian (Chunk-Nummern). Werte > 2^53 kommen praktisch nicht vor. */
export function uint64be(n: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function b64decodeWith(input: string, alphabet: string): Bytes {
  const clean = input.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let pos = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('Ungültiges Base64-Zeichen');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

function b64encodeWith(data: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += alphabet[(buffer >> bits) & 63];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(buffer << (6 - bits)) & 63];
  if (pad) while (out.length % 4 !== 0) out += '=';
  return out;
}

const STD = B64 + '+/';
const URL_SAFE = B64 + '-_';

export const base64 = {
  encode: (d: Uint8Array) => b64encodeWith(d, STD, true),
  decode: (s: string) => b64decodeWith(s, STD),
};

/** Base64url *mit* Padding – so benennt Cryptomator Dateien und `.c9s`-Verzeichnisse. */
export const base64url = {
  encode: (d: Uint8Array) => b64encodeWith(d, URL_SAFE, true),
  encodeNoPad: (d: Uint8Array) => b64encodeWith(d, URL_SAFE, false),
  decode: (s: string) => b64decodeWith(s, URL_SAFE),
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 (Großbuchstaben, ohne Padding – 20 SHA-1-Bytes ergeben exakt 32 Zeichen). */
export function base32Encode(data: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

export function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(s: string): Bytes {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
