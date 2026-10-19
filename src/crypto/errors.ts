export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Ordner enthält keinen (erkennbaren) Cryptomator-Tresor. */
export class NotAVaultError extends VaultError {}

/** Tresor-Format oder Cipher wird (noch) nicht unterstützt. */
export class UnsupportedVaultError extends VaultError {}

export class WrongPasswordError extends VaultError {
  constructor() {
    super('Falsches Passwort.');
  }
}

/** Tresor wurde verändert oder ist beschädigt (Authentifizierung schlägt fehl). */
export class IntegrityError extends VaultError {}

export class ReadOnlyError extends VaultError {
  constructor() {
    super('Dieser Tresor wurde schreibgeschützt geöffnet (Browser ohne Schreibzugriff auf Ordner).');
  }
}

export class NotFoundError extends VaultError {}
