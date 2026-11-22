// HEIC/HEIF anzeigen, wo der Browser es nicht selbst kann (Chrome, Edge, Firefox): Container lokal zerlegen und die
// HEVC-Kacheln mit WebCodecs (VideoDecoder) dekodieren – dieselbe Hardware, mit der der Browser HEVC-Videos abspielt.
// Kein WASM, kein Worker, keine Netzwerkverbindung; die CSP bleibt unverändert.

import { hevcCodecString, parseHeifImage } from './heif';

export class HeicUnsupportedError extends Error {
  constructor() {
    super('HEIC kann dieser Browser nicht anzeigen. Safari kann es immer; Chrome und Edge nur mit HEVC-Unterstützung des Geräts.');
  }
}

let native: Promise<boolean> | undefined;

/** Kann der Browser HEIC selbst dekodieren (Safari)? Einmal pro Sitzung am ersten Bild geprüft. */
function nativeSupport(sample: Blob): Promise<boolean> {
  native ??= createImageBitmap(sample).then((b) => { b.close(); return true; }, () => false);
  return native;
}

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;
function canvas(w: number, h: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
const ctx2d = (c: Canvas2D) => c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const toBlob = (c: Canvas2D): Promise<Blob> =>
  'convertToBlob' in c
    ? c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    : new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Kodieren fehlgeschlagen'))), 'image/jpeg', 0.92));

export async function decodeHeic(blob: Blob): Promise<Blob> {
  if (typeof VideoDecoder === 'undefined') throw new HeicUnsupportedError();
  const img = parseHeifImage(new Uint8Array(await blob.arrayBuffer()));
  const config: VideoDecoderConfig = { codec: hevcCodecString(img.hvcC), description: img.hvcC, codedWidth: img.tileWidth, codedHeight: img.tileHeight, optimizeForLatency: true };
  if (!(await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported) throw new HeicUnsupportedError();

  const grid = canvas(img.width, img.height);
  const g = ctx2d(grid);
  let n = 0;
  let failure: unknown;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const i = n++;
      g.drawImage(frame, (i % img.columns) * img.tileWidth, Math.floor(i / img.columns) * img.tileHeight);
      frame.close();
    },
    error: (e) => { failure = e; },
  });
  try {
    decoder.configure(config);
    // Jede Kachel ist ein eigenständiges Schlüsselbild.
    img.tiles.forEach((data, i) => decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data })));
    await decoder.flush();
  } catch (e) {
    throw failure ?? e;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure || n !== img.tiles.length) throw failure ?? new Error('HEIC-Kacheln unvollständig dekodiert');

  // irot dreht gegen den Uhrzeigersinn, imir spiegelt
  const turns = img.rotation;
  const out = turns % 2 ? canvas(img.height, img.width) : canvas(img.width, img.height);
  const o = ctx2d(out);
  o.translate(out.width / 2, out.height / 2);
  o.rotate((-turns * Math.PI) / 2);
  if (img.mirror === 0) o.scale(-1, 1);
  if (img.mirror === 1) o.scale(1, -1);
  o.drawImage(grid, -img.width / 2, -img.height / 2);
  return toBlob(out);
}

/** Liefert etwas, das <img> anzeigen kann: das Original oder – bei HEIC ohne Browser-Unterstützung – ein JPEG. */
export async function displayable(blob: Blob, heic: boolean): Promise<{ blob: Blob; converted: boolean }> {
  if (!heic || (await nativeSupport(blob))) return { blob, converted: false };
  return { blob: await decodeHeic(blob), converted: true };
}
