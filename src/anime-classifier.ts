import type { Logger } from "./logger.js";
import type { ArrClient, SeriesSummary } from "./clients/arr-client.js";

/**
 * Anime by TheTVDB metadata: tagged "Anime" (or "Animation") and originally Japanese.
 * Western shows TheTVDB tags "Anime" (Scott Pilgrim Takes Off, Star Wars: Visions) and
 * Japanese live action (Kamen Rider) don't qualify.
 */
export function isAnime(s: Pick<SeriesSummary, "genres" | "originalLanguage">): boolean {
  const genres = s.genres ?? [];
  const japanese = s.originalLanguage?.name === "Japanese";
  return japanese && (genres.includes("Anime") || genres.includes("Animation"));
}

export interface AnimeConfig {
  intervalMs: number;
  profileName: string;
  /** Series with this tag are never switched (manual override). */
  optOutTag: string;
  maxChangesPerRun: number;
}

/**
 * Keeps Sonarr's anime set up as anime: once a day, every series that looks like anime
 * but isn't typed "anime" (or isn't on the anime profile) is switched, so Sonarr searches
 * by absolute episode number and scores releases with the anime custom formats.
 * Only ever switches towards anime; tag a series `not-anime` to leave it alone.
 */
export class AnimeClassifier {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private sonarr: ArrClient,
    private cfg: AnimeConfig,
    private dryRun: boolean,
    private logger: Logger,
  ) {}

  start(firstDelayMs = 180_000): void {
    const loop = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error({ err }, "Anime classifier run failed");
      }
      this.timer = setTimeout(loop, this.cfg.intervalMs);
    };
    this.timer = setTimeout(loop, firstDelayMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<string[]> {
    const [series, profiles, tags] = await Promise.all([
      this.sonarr.getSeries(), this.sonarr.getQualityProfiles(), this.sonarr.getTags(),
    ]);
    const profileId = profiles.get(this.cfg.profileName) ?? null;
    if (profileId === null) {
      this.logger.warn({ profile: this.cfg.profileName }, "Anime classifier: profile not found — only setting the series type");
    }
    const optOut = tags.get(this.cfg.optOutTag.toLowerCase()) ?? null;
    const todo = series.filter((s) =>
      isAnime(s)
      && !(optOut !== null && s.tags.includes(optOut))
      && (s.seriesType !== "anime" || (profileId !== null && s.qualityProfileId !== profileId)),
    ).slice(0, this.cfg.maxChangesPerRun);

    if (todo.length === 0) return [];
    const titles = todo.map((s) => s.title);
    if (this.dryRun) {
      this.logger.warn({ series: titles }, "[DRY RUN] Would switch series to anime");
      return titles;
    }
    await this.sonarr.editSeries(todo.map((s) => s.id), {
      seriesType: "anime",
      ...(profileId !== null ? { qualityProfileId: profileId } : {}),
    });
    this.logger.warn({ action: "series_set_anime", count: todo.length, series: titles }, "Switched series to anime");
    return titles;
  }
}
