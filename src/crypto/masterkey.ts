// masterkey.cryptomator: scrypt(Passwort) → KEK → AES-Key-Unwrap (RFC 3394) → Master-Keys.

import { scryptAsync } from '@noble/hashes/scrypt';
import { type Bytes, base64, bs, encoder } from './bytes';
import { NotAVaultError, UnsupportedVaultError, WrongPasswordError } from './errors';

interface MasterkeyFile {
  version?: number;
  scryptSalt: string;
  scryptCostParam: number;
  scryptBlockSize: number;
  primaryMasterKey: string;
  hmacMasterKey: string;
}

export interface RawMasterKeys {
  /** Verschlüsselungs-Master-Key (primaryMasterKey), 32 Byte */
  encKey: Bytes;
  /** MAC-Master-Key (hmacMasterKey), 32 Byte */
  macKey: Bytes;
}

function parseMasterkeyFile(text: string): MasterkeyFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NotAVaultError('masterkey.cryptomator ist keine gültige JSON-Datei.');
  }
  const f = json as Partial<MasterkeyFile>;
  if (
    typeof f.scryptSalt !== 'string' ||
    typeof f.scryptCostParam !== 'number' ||
    typeof f.scryptBlockSize !== 'number' ||
    typeof f.primaryMasterKey !== 'string' ||
    typeof f.hmacMasterKey !== 'string'
  ) {
    throw new NotAVaultError('masterkey.cryptomator hat ein unerwartetes Format.');
  }
  const n = f.scryptCostParam;
  // Schutz vor manipulierten Dateien, die den Browser mit riesigem Speicherbedarf lahmlegen.
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0 || n > 1 << 20 || f.scryptBlockSize < 1 || f.scryptBlockSize > 32) {
    throw new UnsupportedVaultError('Ungültige scrypt-Parameter im masterkey.cryptomator.');
  }
  return f as MasterkeyFile;
}

async function unwrap(kek: CryptoKey, wrappedB64: string): Promise<Bytes> {
  try {
    const key = await crypto.subtle.unwrapKey('raw', bs(base64.decode(wrappedB64)), kek, 'AES-KW', { name: 'AES-CBC' }, true, ['encrypt']);
    return new Uint8Array(await crypto.subtle.exportKey('raw', key));
  } catch {
    // Der AES-KW-Integritätscheck schlägt fehl, wenn das KEK (= das Passwort) falsch ist.
    throw new WrongPasswordError();
  }
}

export async function unlockMasterkeyFile(
  text: string,
  password: string,
  onProgress?: (fraction: number) => void,
): Promise<RawMasterKeys> {
  const file = parseMasterkeyFile(text);
  const salt = base64.decode(file.scryptSalt);

  // Je nach Cryptomator-Version wurde das Passwort evtl. NFC-normalisiert oder unverändert verwendet.
  const candidates = [password.normalize('NFC')];
  if (password !== candidates[0]) candidates.push(password);

  for (const candidate of candidates) {
    const kekBytes = await scryptAsync(encoder.encode(candidate), salt, {
      N: file.scryptCostParam,
      r: file.scryptBlockSize,
      p: 1,
      dkLen: 32,
      onProgress,
    });
    const kek = await crypto.subtle.importKey('raw', bs(kekBytes), 'AES-KW', false, ['unwrapKey']);
    kekBytes.fill(0);
    try {
      return {
        encKey: await unwrap(kek, file.primaryMasterKey),
        macKey: await unwrap(kek, file.hmacMasterKey),
      };
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e;
    }
  }
  throw new WrongPasswordError();
}
