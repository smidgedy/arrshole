/** A file inside a torrent, as reported by qBittorrent's /torrents/files. */
export interface TorrentFile {
  name: string;
  size: number;
}

export type MediaKind = "video" | "audio";

export type ReleaseVerdict = { bad: false } | { bad: true; reason: string };

/** What each *arr imports. Disc images (.iso etc.) deliberately don't count as video. */
export const VIDEO_EXTS = new Set([
  "mkv", "mp4", "m4v", "avi", "ts", "m2ts", "mts", "mov", "wmv", "webm", "mpg", "mpeg", "vob", "divx", "flv", "ogm",
]);
export const AUDIO_EXTS = new Set([
  "flac", "mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wav", "wv", "ape", "alac", "aiff", "aif", "dsf", "dff", "wma", "mka",
]);

/** Sample clips are video, but a release that is only a sample isn't a real release. */
export const SAMPLE_MAX_BYTES = 500 * 1024 * 1024;

export function ext(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

export function isSample(name: string, size: number): boolean {
  return /(^|[\W_])sample([\W_]|$)/i.test(name) && size < SAMPLE_MAX_BYTES;
}

export function kindForApp(app: string): MediaKind | null {
  if (app === "sonarr" || app === "radarr") return "video";
  if (app === "lidarr") return "audio";
  return null;
}

/**
 * A release is bad if it doesn't contain at least one file of the type its *arr imports:
 * a (non-sample) video file for Sonarr/Radarr, an audio file for Lidarr.
 */
export function classifyRelease(files: TorrentFile[], kind: MediaKind): ReleaseVerdict {
  if (files.length === 0) return { bad: false }; // metadata not available yet

  const wanted = kind === "video" ? VIDEO_EXTS : AUDIO_EXTS;
  const ok = files.some((f) => wanted.has(ext(f.name)) && !(kind === "video" && isSample(f.name, f.size)));
  if (ok) return { bad: false };

  const largest = files.reduce((a, b) => (b.size > a.size ? b : a));
  return { bad: true, reason: `no ${kind} file in release (largest file: ${baseName(largest.name)})` };
}
