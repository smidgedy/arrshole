import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { AUDIO_EXTS, VIDEO_EXTS, baseName, ext, isSample, type MediaKind } from "./release-inspector.js";

/** Executables, scripts, shortcuts, installers: never wanted in a media library. */
export const MALWARE_EXTS = new Set([
  "exe", "com", "bat", "cmd", "scr", "pif", "lnk", "msi", "msp", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "ps1", "hta", "cpl", "jar", "reg", "apk", "dll", "url", "website",
]);

/** Release cruft a video library never uses (the *arrs import only video + subtitles here). */
const VIDEO_JUNK_EXTS = new Set([
  "txt", "nfo", "jpg", "jpeg", "png", "gif", "bmp", "webp", "iso", "img", "dmg", "nrg",
  "sfv", "md5", "torrent", "par2", "diz",
]);

const SUBTITLE_EXTS = new Set(["srt", "ass", "ssa", "sub", "idx", "sup", "vtt", "smi"]);

export type FileVerdict = { remove: false } | { remove: true; reason: string };

/**
 * Decide whether a file sitting next to a freshly imported item should be removed.
 * Video libraries: remove malware types, release cruft and sample clips; keep video and subtitles.
 * Audio libraries: remove malware types only (cue sheets, logs and cover art are wanted).
 * Unknown extensions are kept: when in doubt, leave it.
 */
export function classifyLibraryFile(name: string, size: number, kind: MediaKind, importedName: string): FileVerdict {
  const e = ext(name);
  if (baseName(name) === baseName(importedName)) return { remove: false };
  if (MALWARE_EXTS.has(e)) return { remove: true, reason: `malware-carrying type .${e}` };
  if (kind === "audio") return { remove: false };
  if (VIDEO_EXTS.has(e)) {
    return isSample(name, size) ? { remove: true, reason: "sample clip" } : { remove: false };
  }
  if (SUBTITLE_EXTS.has(e) || AUDIO_EXTS.has(e)) return { remove: false };
  if (VIDEO_JUNK_EXTS.has(e)) return { remove: true, reason: `release cruft .${e}` };
  return { remove: false };
}

/** Map an *arr (Windows) path to this host's path using "FROM=TO" prefix rules, e.g. "J:\\=/mnt/j/". */
export function translatePath(arrPath: string, maps: Array<[string, string]>): string | null {
  const norm = arrPath.replace(/\\/g, "/");
  for (const [from, to] of maps) {
    const f = from.replace(/\\/g, "/");
    if (norm.toLowerCase().startsWith(f.toLowerCase())) return to + norm.slice(f.length);
  }
  return null;
}

/**
 * Clean the folder an item was imported into (top level only). Returns the number of files
 * removed (or that would be, in dry run). `budget` caps removals for this call.
 */
export function cleanImportFolder(
  importedPath: string,
  kind: MediaKind,
  opts: { dryRun: boolean; budget: number; logger: Logger; app: string },
): number {
  const folder = importedPath.replace(/[\\/][^\\/]+$/, "");
  const importedName = baseName(importedPath);
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch (err) {
    opts.logger.warn({ folder, err }, "Library cleanup: can't read import folder");
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (removed >= opts.budget) break;
    const full = join(folder, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const verdict = classifyLibraryFile(name, st.size, kind, importedName);
    if (!verdict.remove) continue;
    if (opts.dryRun) {
      opts.logger.info({ app: opts.app, file: full, reason: verdict.reason }, "[DRY RUN] Would remove library cruft");
    } else {
      try {
        unlinkSync(full);
      } catch (err) {
        opts.logger.error({ app: opts.app, file: full, err }, "Library cleanup: failed to remove file");
        continue;
      }
      opts.logger.warn({ action: "library_cruft_removed", app: opts.app, file: full, reason: verdict.reason }, "Removed library cruft");
    }
    removed++;
  }
  return removed;
}
