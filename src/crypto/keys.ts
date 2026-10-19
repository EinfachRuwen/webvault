import { AesSiv } from './siv';
import { bs } from './bytes';
import type { RawMasterKeys } from './masterkey';

/** Alle aus den Master-Keys abgeleiteten, nicht exportierbaren WebCrypto-Schlüssel. */
export interface VaultKeys {
  siv: AesSiv;
  /** encKey als AES-GCM-Schlüssel (Datei-Header bei SIV_GCM) */
  encGcm: CryptoKey;
  /** encKey als AES-CTR-Schlüssel (Datei-Header bei SIV_CTRMAC) */
  encCtr: CryptoKey;
  /** macKey als HMAC-SHA256-Schlüssel (Header- und Chunk-MACs bei SIV_CTRMAC) */
  mac: CryptoKey;
}

export async function deriveVaultKeys(raw: RawMasterKeys): Promise<VaultKeys> {
  const subtle = crypto.subtle;
  const [siv, encGcm, encCtr, mac] = await Promise.all([
    AesSiv.create(raw.encKey, raw.macKey),
    subtle.importKey('raw', bs(raw.encKey), 'AES-GCM', false, ['encrypt', 'decrypt']),
    subtle.importKey('raw', bs(raw.encKey), 'AES-CTR', false, ['encrypt', 'decrypt']),
    subtle.importKey('raw', bs(raw.macKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
  ]);
  return { siv, encGcm, encCtr, mac };
}
