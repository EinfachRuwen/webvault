import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '../src/crypto/bytes';
import { AesSiv } from '../src/crypto/siv';

// RFC 5297, Anhang A. Schlüssel = K1 (S2V/CMAC) ‖ K2 (CTR).
describe('AES-SIV (RFC 5297)', () => {
  it('A.1 Deterministic Authenticated Encryption', async () => {
    const key = fromHex('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0 f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
    const siv = await AesSiv.create(key.slice(16), key.slice(0, 16));
    const ad = fromHex('101112131415161718191a1b1c1d1e1f2021222324252627');
    const pt = fromHex('112233445566778899aabbccddee');
    const ct = await siv.encrypt(pt, ad);
    expect(hex(ct)).toBe('85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c');
    expect(hex(await siv.decrypt(ct, ad))).toBe(hex(pt));
  });

  it('A.2 Nonce-Based Authenticated Encryption', async () => {
    const key = fromHex('7f7e7d7c7b7a79787776757473727170 404142434445464748494a4b4c4d4e4f');
    const siv = await AesSiv.create(key.slice(16), key.slice(0, 16));
    const ad1 = fromHex('00112233445566778899aabbccddeeffdeaddadadeaddadaffeeddccbbaa99887766554433221100');
    const ad2 = fromHex('102030405060708090a0');
    const nonce = fromHex('09f911029d74e35bd84156c5635688c0');
    const pt = fromHex('7468697320697320736f6d6520706c61696e7465787420746f20656e6372797074207573696e67205349562d414553');
    const ct = await siv.encrypt(pt, ad1, ad2, nonce);
    expect(hex(ct)).toBe(
      '7bdb6e3b432667eb06f4d14bff2fbd0fcb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d',
    );
    expect(hex(await siv.decrypt(ct, ad1, ad2, nonce))).toBe(hex(pt));
  });

  it('erkennt manipulierte Daten und falsche Associated Data', async () => {
    const siv = await AesSiv.create(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const ct = await siv.encrypt(new TextEncoder().encode('geheim'), new TextEncoder().encode('ad'));
    const bad = ct.slice();
    bad[bad.length - 1] ^= 1;
    await expect(siv.decrypt(bad, new TextEncoder().encode('ad'))).rejects.toThrow();
    await expect(siv.decrypt(ct, new TextEncoder().encode('andere'))).rejects.toThrow();
  });

  it('verarbeitet leeren Klartext (Root-Verzeichnis-ID)', async () => {
    const siv = await AesSiv.create(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const ct = await siv.encrypt(new Uint8Array(0));
    expect(ct.length).toBe(16);
    expect((await siv.decrypt(ct)).length).toBe(0);
  });
});
