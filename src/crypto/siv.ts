// AES-SIV (RFC 5297) auf Basis von WebCrypto.
// WebCrypto kennt weder AES-ECB noch CMAC noch SIV – daher:
//  * AES-Blockoperation  = AES-CBC mit Null-IV über genau einen Block
//  * CMAC                = CBC-MAC über das (mit K1/K2 präparierte) letzte Block
//  * CTR                 = AES-CTR mit 128-Bit-Zähler (wie Javas AES/CTR/NoPadding)
// Cryptomator verwendet zwei getrennte 256-Bit-Schlüssel (Verschlüsselungs- und MAC-Master-Key).

import { type Bytes, bs, concat, equalConstantTime, xor } from './bytes';

const BLOCK = 16;
const ZERO_BLOCK = new Uint8Array(BLOCK);

/** Verdoppelung in GF(2^128) (RFC 5297 §2.3 / RFC 4493 §2.3). */
function dbl(b: Uint8Array): Bytes {
  const out = new Uint8Array(BLOCK);
  const carry = b[0] & 0x80;
  for (let i = 0; i < BLOCK - 1; i++) out[i] = ((b[i] << 1) | (b[i + 1] >> 7)) & 0xff;
  out[BLOCK - 1] = (b[BLOCK - 1] << 1) & 0xff;
  if (carry) out[BLOCK - 1] ^= 0x87;
  return out;
}

export class AesSiv {
  private constructor(
    private readonly ctrKey: CryptoKey,
    private readonly cbcKey: CryptoKey,
    private readonly k1: Bytes,
    private readonly k2: Bytes,
  ) {}

  /**
   * @param ctrKey Schlüssel für die CTR-Verschlüsselung (bei RFC 5297: K2)
   * @param macKey Schlüssel für S2V/CMAC (bei RFC 5297: K1)
   */
  static async create(ctrKey: Uint8Array, macKey: Uint8Array): Promise<AesSiv> {
    const subtle = crypto.subtle;
    const ctr = await subtle.importKey('raw', bs(ctrKey), 'AES-CTR', false, ['encrypt', 'decrypt']);
    const cbc = await subtle.importKey('raw', bs(macKey), 'AES-CBC', false, ['encrypt']);
    const l = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: ZERO_BLOCK }, cbc, ZERO_BLOCK)).subarray(0, BLOCK);
    const k1 = dbl(l);
    const k2 = dbl(k1);
    return new AesSiv(ctr, cbc, k1, k2);
  }

  private async cmac(data: Uint8Array): Promise<Bytes> {
    const n = Math.max(1, Math.ceil(data.length / BLOCK));
    const complete = data.length > 0 && data.length % BLOCK === 0;
    const buf = new Uint8Array(n * BLOCK);
    buf.set(data);
    if (!complete) buf[data.length] = 0x80;
    const subkey = complete ? this.k1 : this.k2;
    const last = (n - 1) * BLOCK;
    for (let i = 0; i < BLOCK; i++) buf[last + i] ^= subkey[i];
    // CBC-Verschlüsselung hängt einen Padding-Block an; der MAC ist der letzte *echte* Block.
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO_BLOCK }, this.cbcKey, buf));
    return enc.slice(last, last + BLOCK);
  }

  private async s2v(plaintext: Uint8Array, associatedData: Uint8Array[]): Promise<Bytes> {
    let d = await this.cmac(ZERO_BLOCK);
    for (const ad of associatedData) d = xor(dbl(d), await this.cmac(ad));
    let t: Uint8Array;
    if (plaintext.length >= BLOCK) {
      t = plaintext.slice();
      const off = t.length - BLOCK;
      for (let i = 0; i < BLOCK; i++) t[off + i] ^= d[i];
    } else {
      const padded = new Uint8Array(BLOCK);
      padded.set(plaintext);
      padded[plaintext.length] = 0x80;
      t = xor(dbl(d), padded);
    }
    return this.cmac(t);
  }

  private async ctr(iv: Uint8Array, data: Uint8Array, mode: 'encrypt' | 'decrypt'): Promise<Bytes> {
    if (data.length === 0) return new Uint8Array(0);
    // RFC 5297 §2.6: Bit 31 und 63 (von rechts) des IV werden gelöscht.
    const q = iv.slice();
    q[8] &= 0x7f;
    q[12] &= 0x7f;
    const params = { name: 'AES-CTR', counter: q, length: 128 };
    const out =
      mode === 'encrypt'
        ? await crypto.subtle.encrypt(params, this.ctrKey, bs(data))
        : await crypto.subtle.decrypt(params, this.ctrKey, bs(data));
    return new Uint8Array(out);
  }

  /** Liefert `SIV ‖ Ciphertext`. */
  async encrypt(plaintext: Uint8Array, ...associatedData: Uint8Array[]): Promise<Bytes> {
    const siv = await this.s2v(plaintext, associatedData);
    return concat(siv, await this.ctr(siv, plaintext, 'encrypt'));
  }

  async decrypt(ciphertext: Uint8Array, ...associatedData: Uint8Array[]): Promise<Bytes> {
    if (ciphertext.length < BLOCK) throw new Error('SIV-Ciphertext zu kurz');
    const siv = ciphertext.slice(0, BLOCK);
    const plaintext = await this.ctr(siv, ciphertext.subarray(BLOCK), 'decrypt');
    const check = await this.s2v(plaintext, associatedData);
    if (!equalConstantTime(siv, check)) throw new Error('SIV-Authentifizierung fehlgeschlagen');
    return plaintext;
  }
}
