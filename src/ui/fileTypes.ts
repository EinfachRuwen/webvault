export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

const TYPES: Record<string, [PreviewKind, string]> = {
  // Bilder (SVG wird nur per <img> gerendert – dort laufen keine Skripte)
  jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], png: ['image', 'image/png'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], avif: ['image', 'image/avif'], bmp: ['image', 'image/bmp'], svg: ['image', 'image/svg+xml'],
  ico: ['image', 'image/x-icon'], heic: ['image', 'image/heic'], heif: ['image', 'image/heif'],
  // Video
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'], ogv: ['video', 'video/ogg'],
  // Audio
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'], oga: ['audio', 'audio/ogg'], m4a: ['audio', 'audio/mp4'],
  flac: ['audio', 'audio/flac'], opus: ['audio', 'audio/ogg'], aac: ['audio', 'audio/aac'],
  pdf: ['pdf', 'application/pdf'],
};

const TEXT_EXT = new Set(
  ('txt md markdown json jsonc csv tsv log xml yml yaml toml ini conf cfg env gitignore js mjs cjs ts tsx jsx css scss html htm py rb go rs java kt c h cpp hpp cs php sh bash zsh ps1 sql tex bib rtf srt vtt lua r swift gradle properties').split(' '),
);

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function fileInfo(name: string): { kind?: PreviewKind; mime: string } {
  const ext = extensionOf(name);
  const known = TYPES[ext];
  if (known) return { kind: known[0], mime: known[1] };
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain' };
  return { mime: 'application/octet-stream' };
}

/** Versteckte Einträge im Mac/Unix-Sinn: Name beginnt mit einem Punkt (.DS_Store, ._IMG_1234.jpg, .webvault …). */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

const HEIC_EXT = new Set(['heic', 'heif']);
export const isHeicName = (name: string) => HEIC_EXT.has(extensionOf(name));

let quicktimeOk: boolean | undefined;
/**
 * MIME-Typ für die Wiedergabe. Chrome/Edge lehnen `video/quicktime` ab, spielen iPhone-.mov (H.264/HEVC im
 * ISO-Container) aber als `video/mp4` ab – deshalb wird dort umetikettiert.
 */
export function playableMime(name: string): string {
  const { mime } = fileInfo(name);
  if (mime !== 'video/quicktime' || typeof document === 'undefined') return mime;
  quicktimeOk ??= document.createElement('video').canPlayType('video/quicktime') !== '';
  return quicktimeOk ? mime : 'video/mp4';
}
