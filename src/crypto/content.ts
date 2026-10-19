// Dateiinhalte: Header + Chunks à 32 KiB (SIV_GCM und SIV_CTRMAC).
//
// SIV_GCM    Header: nonce(12) ‖ AES-GCM(encKey)[0xFF×8 ‖ fileKey(32)] ‖ tag(16)            = 68 Byte
//            Chunk : nonce(12) ‖ AES-GCM(fileKey, aad = chunkNr(8) ‖ headerNonce)[…] ‖ tag(16)
// SIV_CTRMAC Header: nonce(16) ‖ AES-CTR(encKey)[0xFF×8 ‖ fileKey(32)] ‖ HMAC(macKey, nonce ‖ ct) = 88 Byte
//            Chunk : nonce(16) ‖ AES-CTR(fileKey)[…] ‖ HMAC(macKey, headerNonce ‖ chunkNr(8) ‖ nonce ‖ ct)

import { type Bytes, bs, concat, equalConstantTime, randomBytes, uint64be } from './bytes';
import { IntegrityError } from './errors';
import type { VaultKeys } from './keys';
import type { CipherCombo } from './vaultconfig';

export const CHUNK_SIZE = 32 * 1024;
const RESERVED = new Uint8Array(8).fill(0xff);
const HEADER_PAYLOAD_LEN = 40;
/** Wie viele Chunks gleichzeitig gelesen/entschlüsselt werden. */
const BATCH_CHUNKS = 64;

interface FileHeader {
  nonce: Bytes;
  fileKey: CryptoKey;
}

export class ContentCryptor {
  readonly headerSize: number;
  private readonly nonceLen: number;
  private readonly chunkOverhead: number;
  private readonly chunkSizeEncrypted: number;

  constructor(
    private readonly keys: VaultKeys,
    readonly combo: CipherCombo,
  ) {
    if (combo === 'SIV_GCM') {
      this.nonceLen = 12;
      this.headerSize = 12 + HEADER_PAYLOAD_LEN + 16;
      this.chunkOverhead = 12 + 16;
    } else {
      this.nonceLen = 16;
      this.headerSize = 16 + HEADER_PAYLOAD_LEN + 32;
      this.chunkOverhead = 16 + 32;
    }
    this.chunkSizeEncrypted = CHUNK_SIZE + this.chunkOverhead;
  }

  /** Klartextgröße aus der Größe der verschlüsselten Datei. */
  cleartextSize(encryptedSize: number): number {
    const payload = encryptedSize - this.headerSize;
    if (payload <= 0) return 0;
    const full = Math.floor(payload / this.chunkSizeEncrypted);
    const rest = payload % this.chunkSizeEncrypted;
    return full * CHUNK_SIZE + Math.max(0, rest - this.chunkOverhead);
  }

  // ---------- Header ----------

  private async parseHeader(header: Uint8Array): Promise<FileHeader> {
    if (header.length < this.headerSize) throw new IntegrityError('Datei-Header ist unvollständig.');
    const nonce = header.slice(0, this.nonceLen);
    let payload: Uint8Array;
    try {
      if (this.combo === 'SIV_GCM') {
        const ct = header.subarray(this.nonceLen, this.headerSize);
        payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, this.keys.encGcm, bs(ct)));
      } else {
        const ct = header.subarray(this.nonceLen, this.nonceLen + HEADER_PAYLOAD_LEN);
        const mac = header.subarray(this.nonceLen + HEADER_PAYLOAD_LEN, this.headerSize);
        const ok = await crypto.subtle.verify('HMAC', this.keys.mac, bs(mac), bs(concat(nonce, ct)));
        if (!ok) throw new Error('mac');
        payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: nonce, length: 128 }, this.keys.encCtr, bs(ct)));
      }
    } catch {
      throw new IntegrityError('Datei-Header konnte nicht authentifiziert werden (beschädigt oder falscher Schlüssel).');
    }
    const fileKey = await crypto.subtle.importKey(
      'raw',
      bs(payload.subarray(8, HEADER_PAYLOAD_LEN)),
      this.combo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR',
      false,
      ['encrypt', 'decrypt'],
    );
    payload.fill(0);
    return { nonce, fileKey };
  }

  private async createHeader(): Promise<{ bytes: Bytes; header: FileHeader }> {
    const nonce = randomBytes(this.nonceLen);
    const fileKeyRaw = randomBytes(32);
    const payload = concat(RESERVED, fileKeyRaw);
    let bytes: Bytes;
    if (this.combo === 'SIV_GCM') {
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, this.keys.encGcm, bs(payload)));
      bytes = concat(nonce, ct);
    } else {
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: nonce, length: 128 }, this.keys.encCtr, bs(payload)));
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', this.keys.mac, bs(concat(nonce, ct))));
      bytes = concat(nonce, ct, mac);
    }
    const fileKey = await crypto.subtle.importKey('raw', bs(fileKeyRaw), this.combo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR', false, ['encrypt', 'decrypt']);
    fileKeyRaw.fill(0);
    payload.fill(0);
    return { bytes, header: { nonce, fileKey } };
  }

  // ---------- Chunks ----------

  private async decryptChunk(header: FileHeader, index: number, chunk: Uint8Array): Promise<Bytes> {
    if (chunk.length < this.chunkOverhead) throw new IntegrityError(`Chunk ${index} ist zu kurz.`);
    const nonce = bs(chunk.subarray(0, this.nonceLen));
    try {
      if (this.combo === 'SIV_GCM') {
        const aad = concat(uint64be(index), header.nonce);
        const ct = chunk.subarray(this.nonceLen);
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, header.fileKey, bs(ct)));
      }
      const ct = chunk.subarray(this.nonceLen, chunk.length - 32);
      const mac = chunk.subarray(chunk.length - 32);
      const expected = new Uint8Array(await crypto.subtle.sign('HMAC', this.keys.mac, bs(concat(header.nonce, uint64be(index), nonce, ct))));
      if (!equalConstantTime(mac, expected)) throw new Error('mac');
      if (ct.length === 0) return new Uint8Array(0);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: nonce, length: 128 }, header.fileKey, bs(ct)));
    } catch {
      throw new IntegrityError(`Chunk ${index} konnte nicht authentifiziert werden – die Datei ist beschädigt oder wurde manipuliert.`);
    }
  }

  private async encryptChunk(header: FileHeader, index: number, data: Uint8Array): Promise<Bytes> {
    const nonce = randomBytes(this.nonceLen);
    if (this.combo === 'SIV_GCM') {
      const aad = concat(uint64be(index), header.nonce);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, header.fileKey, bs(data)));
      return concat(nonce, ct);
    }
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: nonce, length: 128 }, header.fileKey, bs(data)));
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', this.keys.mac, bs(concat(header.nonce, uint64be(index), nonce, ct))));
    return concat(nonce, ct, mac);
  }

  // ---------- Streaming ----------

  /** Entschlüsselt eine komplette verschlüsselte Datei und liefert Klartext-Stücke. */
  async *decrypt(file: Blob, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const header = await this.parseHeader(new Uint8Array(await file.slice(0, this.headerSize).arrayBuffer()));
    const batchBytes = BATCH_CHUNKS * this.chunkSizeEncrypted;
    let chunkIndex = 0;
    for (let pos = this.headerSize; pos < file.size; pos += batchBytes) {
      signal?.throwIfAborted();
      const buf = new Uint8Array(await file.slice(pos, Math.min(pos + batchBytes, file.size)).arrayBuffer());
      const jobs: Promise<Bytes>[] = [];
      for (let off = 0; off < buf.length; off += this.chunkSizeEncrypted) {
        jobs.push(this.decryptChunk(header, chunkIndex++, buf.subarray(off, off + this.chunkSizeEncrypted)));
      }
      const parts = await Promise.all(jobs);
      yield parts.length === 1 ? parts[0] : concat(...parts);
    }
  }

  /** Verschlüsselt `source` und liefert Header + Chunks als zusammenhängenden Byte-Strom. */
  async *encrypt(source: Blob, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const { bytes, header } = await this.createHeader();
    yield bytes;
    const batchBytes = BATCH_CHUNKS * CHUNK_SIZE;
    let chunkIndex = 0;
    for (let pos = 0; pos < source.size; pos += batchBytes) {
      signal?.throwIfAborted();
      const buf = new Uint8Array(await source.slice(pos, Math.min(pos + batchBytes, source.size)).arrayBuffer());
      const jobs: Promise<Bytes>[] = [];
      for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
        jobs.push(this.encryptChunk(header, chunkIndex++, buf.subarray(off, off + CHUNK_SIZE)));
      }
      const parts = await Promise.all(jobs);
      yield parts.length === 1 ? parts[0] : concat(...parts);
    }
  }
}
