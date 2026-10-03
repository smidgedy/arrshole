/** A file inside a torrent, as reported by qBittorrent's /torrents/files. */
export interface TorrentFile {
  name: string;
  size: number;
}

export type ReleaseVerdict = { bad: false } | { bad: true; reason: string };

/** Never legitimate in a TV/movie release: executables, scripts, shortcuts, installers. */
const DANGEROUS = new Set([
  "exe", "scr", "com", "pif", "lnk", "bat", "cmd", "msi", "msp", "vbs", "vbe",
  "js", "jse", "wsf", "wsh", "ps1", "hta", "cpl", "jar", "reg", "apk", "dll",
]);

/** Disc images: the classic wrapper for a padded fake (an .exe inside an .iso). */
const DISC_IMAGES = new Set(["iso", "img", "dmg", "nrg", "mdf", "vhd", "vhdx"]);

const VIDEO = new Set(["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "mov", "wmv", "webm", "mpg", "mpeg", "vob"]);

/**
 * Genuine (old) RARBG releases ship a tiny decoy executable. It is never imported, so a
 * real release carrying it is fine; anything bigger with that name is not.
 */
const ALLOWED_DECOYS = new Map([["rarbg_do_not_mirror.exe", 1024 * 1024]]);

function ext(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Decide whether a TV/movie torrent is a fake or malicious release, from its file list alone.
 * Bad if it contains any executable/script (bar the known RARBG decoy), if its main payload is
 * a disc image, or if it contains no video at all.
 */
export function classifyRelease(files: TorrentFile[]): ReleaseVerdict {
  if (files.length === 0) return { bad: false }; // metadata not available yet

  for (const f of files) {
    const base = (f.name.split(/[\\/]/).pop() ?? f.name).toLowerCase();
    const decoyLimit = ALLOWED_DECOYS.get(base);
    if (decoyLimit !== undefined && f.size <= decoyLimit) continue;
    if (DANGEROUS.has(ext(f.name))) {
      return { bad: true, reason: `contains executable/script: ${f.name}` };
    }
  }

  const largest = files.reduce((a, b) => (b.size > a.size ? b : a));
  if (DISC_IMAGES.has(ext(largest.name))) {
    return { bad: true, reason: `main file is a disc image: ${largest.name}` };
  }

  if (!files.some((f) => VIDEO.has(ext(f.name)))) {
    return { bad: true, reason: `no video files (largest: ${largest.name})` };
  }

  return { bad: false };
}
