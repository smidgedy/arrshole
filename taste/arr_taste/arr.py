"""Read-only access to Radarr/Sonarr: library, tags, custom filters, import-list exclusions.

Rows are normalised to the same columns the model uses, so library rows and stored
history (deleted/excluded items) line up.
"""
from __future__ import annotations

import logging
import time

import requests

log = logging.getLogger(__name__)
TIMEOUT = 120


class Arr:
    def __init__(self, app: str, url: str, api_key: str):
        self.app = app
        self.url = url.rstrip("/")
        self.s = requests.Session()
        self.s.headers["X-Api-Key"] = api_key

    def get(self, path: str):
        for attempt in range(3):
            try:
                r = self.s.get(f"{self.url}/api/v3{path}", timeout=TIMEOUT)
                r.raise_for_status()
                return r.json()
            except requests.RequestException:
                if attempt == 2:
                    raise
                time.sleep(5 * (attempt + 1))

    def tags(self) -> dict[str, int]:
        return {t["label"].lower(): t["id"] for t in self.get("/tag")}

    def custom_filters(self) -> list[dict]:
        typ = "movieIndex" if self.app == "radarr" else "series"
        return [{"id": f["id"], "name": f["label"], "conditions": f["filters"]}
                for f in self.get("/customfilter") if f["type"] == typ]

    def exclusions(self) -> list[dict]:
        if self.app == "radarr":
            return [{"id": e["tmdbId"], "title": e.get("movieTitle"), "year": e.get("movieYear")}
                    for e in self.get("/exclusions")]
        return [{"id": e["tvdbId"], "title": e.get("title")} for e in self.get("/importlistexclusion")]

    def library(self) -> list[dict]:
        if self.app == "radarr":
            return [movie_row(m) for m in self.get("/movie")]
        return [series_row(s) for s in self.get("/series")]


def _rating(r: dict | None, key: str):
    r = (r or {}).get(key) or {}
    return r.get("value"), r.get("votes")


def movie_row(m: dict) -> dict:
    rat = m.get("ratings") or {}
    imdb, imdb_v = _rating(rat, "imdb")
    tmdb, tmdb_v = _rating(rat, "tmdb")
    trakt, trakt_v = _rating(rat, "trakt")
    rt, _ = _rating(rat, "rottenTomatoes")
    mc, _ = _rating(rat, "metacritic")
    size = m.get("sizeOnDisk") or (m.get("statistics") or {}).get("sizeOnDisk") or 0
    return {
        "id": m["tmdbId"], "arr_id": m["id"], "imdb_id": m.get("imdbId"), "title": m["title"],
        "original_title": m.get("originalTitle"), "year": m.get("year"),
        "language": (m.get("originalLanguage") or {}).get("name"),
        "genres": m.get("genres") or [], "keywords": m.get("keywords") or [],
        "studio": m.get("studio"), "runtime": m.get("runtime"), "certification": m.get("certification"),
        "popularity": float(m.get("popularity") or 0),
        "collection": (m.get("collection") or {}).get("title"),
        "in_cinemas": m.get("inCinemas"), "digital_release": m.get("digitalRelease"),
        "physical_release": m.get("physicalRelease"),
        "imdb_rating": imdb, "imdb_votes": imdb_v, "tmdb_rating": tmdb, "tmdb_votes": tmdb_v,
        "rt_rating": rt, "metacritic": mc, "trakt_rating": trakt, "trakt_votes": trakt_v,
        "tags": m.get("tags") or [], "has_file": bool(m.get("hasFile")), "size": size,
        "added": m.get("added"),
    }


def series_row(s: dict) -> dict:
    rat = s.get("ratings") or {}
    st = s.get("statistics") or {}
    seasons = [x for x in s.get("seasons") or [] if x.get("seasonNumber", 0) > 0]
    episodes = sum((x.get("statistics") or {}).get("totalEpisodeCount", 0) for x in seasons)
    return {
        "id": s["tvdbId"], "arr_id": s["id"], "imdb_id": s.get("imdbId"), "tmdb_id": s.get("tmdbId"),
        "title": s["title"], "year": s.get("year"),
        "language": (s.get("originalLanguage") or {}).get("name"),
        "genres": s.get("genres") or [], "network": s.get("network"), "runtime": s.get("runtime"),
        "certification": s.get("certification"), "status": s.get("status"),
        "series_type": s.get("seriesType"), "first_aired": s.get("firstAired"),
        "last_aired": s.get("lastAired"), "rating": rat.get("value"), "rating_votes": rat.get("votes"),
        "season_count": st.get("seasonCount", len(seasons)), "episode_count": episodes,
        "tags": s.get("tags") or [], "size": st.get("sizeOnDisk") or 0,
        "has_file": (st.get("episodeFileCount") or 0) > 0, "added": s.get("added"),
    }
