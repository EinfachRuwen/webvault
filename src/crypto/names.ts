// Verzeichnis-IDs und Dateinamen (AES-SIV).

import { type Bytes, base32Encode, base64url, bs, decoder, encoder } from './bytes';
import type { VaultKeys } from './keys';

export const ENCRYPTED_SUFFIX = '.c9r';
export const SHORTENED_SUFFIX = '.c9s';

export class NameCryptor {
  private readonly dirPathCache = new Map<string, string[]>();

  constructor(
    private readonly keys: VaultKeys,
    readonly shorteningThreshold: number,
  ) {}

  /** `['d', 'AB', 'CDEF…']` – Speicherort der Inhalte eines Verzeichnisses (Root hat die ID ""). */
  async dirStoragePath(dirId: string): Promise<string[]> {
    const cached = this.dirPathCache.get(dirId);
    if (cached) return cached;
    const encrypted = await this.keys.siv.encrypt(encoder.encode(dirId));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bs(encrypted)));
    const b32 = base32Encode(hash);
    const path = ['d', b32.slice(0, 2), b32.slice(2)];
    this.dirPathCache.set(dirId, path);
    return path;
  }

  /** Klartextname → Base64url-Chiffrat (ohne `.c9r`). Namen werden NFC-normalisiert. */
  async encryptName(name: string, parentDirId: string): Promise<string> {
    const ct = await this.keys.siv.encrypt(encoder.encode(name.normalize('NFC')), encoder.encode(parentDirId));
    return base64url.encode(ct);
  }

  async decryptName(encrypted: string, parentDirId: string): Promise<string> {
    const pt = await this.keys.siv.decrypt(base64url.decode(encrypted), encoder.encode(parentDirId));
    return decoder.decode(pt);
  }

  /**
   * Bestimmt, unter welchem Namen ein Eintrag im Dateisystem liegt.
   * Lange Namen werden zu `<base64url(sha1(name.c9r))>.c9s` gekürzt; der volle Name steht dann in `name.c9s`.
   */
  async storageName(encrypted: string): Promise<{ name: string; shortened: boolean; fullName: string }> {
    const fullName = encrypted + ENCRYPTED_SUFFIX;
    if (fullName.length <= this.shorteningThreshold) return { name: fullName, shortened: false, fullName };
    const hash: Bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', bs(encoder.encode(fullName))));
    return { name: base64url.encode(hash) + SHORTENED_SUFFIX, shortened: true, fullName };
  }
}
