// vault.cryptomator: ein HS256-signiertes JWT mit Format, Cipher-Kombination etc.

import { base64url, bs, concat, decoder, encoder } from './bytes';
import { IntegrityError, NotAVaultError, UnsupportedVaultError } from './errors';
import type { RawMasterKeys } from './masterkey';

export type CipherCombo = 'SIV_GCM' | 'SIV_CTRMAC';

export interface VaultConfig {
  format: number;
  cipherCombo: CipherCombo;
  shorteningThreshold: number;
  /** Pfad der Masterkey-Datei relativ zum Tresor-Ordner */
  masterkeyPath: string;
  signingInput: string;
  signature: Uint8Array;
}

const SUPPORTED_FORMATS = [7, 8];

export function parseVaultConfig(jwt: string): VaultConfig {
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) throw new NotAVaultError('vault.cryptomator ist kein gültiges JWT.');
  let header: { kid?: string; alg?: string };
  let claims: { format?: number; cipherCombo?: string; shorteningThreshold?: number };
  try {
    header = JSON.parse(decoder.decode(base64url.decode(parts[0])));
    claims = JSON.parse(decoder.decode(base64url.decode(parts[1])));
  } catch {
    throw new NotAVaultError('vault.cryptomator ist beschädigt.');
  }
  if (header.alg !== 'HS256') throw new UnsupportedVaultError(`Nicht unterstützter JWT-Algorithmus: ${header.alg}`);

  const kid = header.kid ?? '';
  const prefix = 'masterkeyfile:';
  if (!kid.startsWith(prefix)) {
    throw new UnsupportedVaultError('Dieser Tresor nutzt einen externen Schlüsselspeicher (z. B. Hub) und kann hier nicht geöffnet werden.');
  }
  const masterkeyPath = kid.slice(prefix.length);
  if (!masterkeyPath || masterkeyPath.startsWith('/') || masterkeyPath.split('/').includes('..')) {
    throw new UnsupportedVaultError('Ungültiger Pfad zur Masterkey-Datei.');
  }

  const format = claims.format;
  if (format === undefined || !SUPPORTED_FORMATS.includes(format)) {
    throw new UnsupportedVaultError(
      `Tresor-Format ${format ?? '?'} wird nicht unterstützt (unterstützt: ${SUPPORTED_FORMATS.join(', ')}). Bitte den Tresor in Cryptomator auf das aktuelle Format migrieren.`,
    );
  }
  const combo = claims.cipherCombo;
  if (combo !== 'SIV_GCM' && combo !== 'SIV_CTRMAC') {
    throw new UnsupportedVaultError(`Nicht unterstützte Cipher-Kombination: ${combo}`);
  }
  return {
    format,
    cipherCombo: combo,
    shorteningThreshold: claims.shorteningThreshold ?? 220,
    masterkeyPath,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64url.decode(parts[2]),
  };
}

/** Prüft die JWT-Signatur mit encKey ‖ macKey. Cryptomator selbst verweigert das Öffnen bei Fehlschlag. */
export async function verifyVaultConfig(config: VaultConfig, keys: RawMasterKeys): Promise<void> {
  const key = await crypto.subtle.importKey('raw', bs(concat(keys.encKey, keys.macKey)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, bs(config.signature), bs(encoder.encode(config.signingInput)));
  if (!ok) throw new IntegrityError('Die Signatur von vault.cryptomator ist ungültig – der Tresor wurde verändert oder ist beschädigt.');
}
