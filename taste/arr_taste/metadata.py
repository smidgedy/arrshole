"""Metadata for import-list exclusions (titles that were never in the library while we watched).

Uses the public metadata proxies Radarr/Sonarr themselves use; results are cached in the store.
"""
from __future__ import annotations

import logging
import time

import requests

log = logging.getLogger(__name__)

URL = {
    "radarr": "https://api.radarr.video/v1/movie/{}",
    "sonarr": "https://skyhook.sonarr.tv/v1/tvdb/shows/en/{}",
}

# ISO 639-1/-2 -> arr language names
ISO = {
    "en": "English", "eng": "English", "fr": "French", "fre": "French", "fra": "French",
    "es": "Spanish", "spa": "Spanish", "de": "German", "ger": "German", "deu": "German",
    "it": "Italian", "ita": "Italian", "da": "Danish", "dan": "Danish", "nl": "Dutch",
    "dut": "Dutch", "nld": "Dutch", "ja": "Japanese", "jpn": "Japanese", "is": "Icelandic",
    "ice": "Icelandic", "zh": "Chinese", "cn": "Chinese", "zho": "Chinese", "chi": "Chinese",
    "yue": "Chinese", "ru": "Russian", "rus": "Russian", "pl": "Polish", "pol": "Polish",
    "vi": "Vietnamese", "vie": "Vietnamese", "sv": "Swedish", "swe": "Swedish",
    "no": "Norwegian", "nb": "Norwegian", "nor": "Norwegian", "fi": "Finnish", "fin": "Finnish",
    "tr": "Turkish", "tur": "Turkish", "pt": "Portuguese", "por": "Portuguese", "el": "Greek",
    "gre": "Greek", "ell": "Greek", "ko": "Korean", "kor": "Korean", "hu": "Hungarian",
    "hun": "Hungarian", "he": "Hebrew", "heb": "Hebrew", "lt": "Lithuanian", "cs": "Czech",
    "cze": "Czech", "ces": "Czech", "ar": "Arabic", "ara": "Arabic", "hi": "Hindi", "hin": "Hindi",
    "bg": "Bulgarian", "ml": "Malayalam", "mal": "Malayalam", "uk": "Ukrainian", "ukr": "Ukrainian",
    "sk": "Slovak", "th": "Thai", "tha": "Thai", "ro": "Romanian", "rum": "Romanian",
    "ron": "Romanian", "lv": "Latvian", "fa": "Persian", "per": "Persian", "fas": "Persian",
    "ca": "Catalan", "hr": "Croatian", "sr": "Serbian", "bs": "Bosnian", "et": "Estonian",
    "ta": "Tamil", "tam": "Tamil", "id": "Indonesian", "ind": "Indonesian", "te": "Telugu",
    "tel": "Telugu", "mk": "Macedonian", "sl": "Slovenian", "ms": "Malay", "msa": "Malay",
    "kn": "Kannada", "kan": "Kannada", "sq": "Albanian", "af": "Afrikaans", "mr": "Marathi",
    "mar": "Marathi", "tl": "Tagalog", "tgl": "Tagalog", "fil": "Tagalog", "ur": "Urdu",
    "urd": "Urdu", "bn": "Bengali", "ben": "Bengali", "pa": "Punjabi", "pan": "Punjabi",
    "ka": "Georgian", "mn": "Mongolian", "xx": "Unknown",
}


def fetch(app: str, ident: int, session: requests.Session) -> dict | None:
    """Returns raw proxy JSON, None for a 404, raises after repeated failures."""
    for attempt in range(4):
        try:
            r = session.get(URL[app].format(ident), timeout=20)
        except requests.RequestException:
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 200:
            return r.json()
        if r.status_code == 404:
            return None
        time.sleep(2 ** attempt)
    raise RuntimeError(f"{app} metadata fetch failed for {ident}")


def to_row(app: str, d: dict) -> dict:
    return movie_from_proxy(d) if app == "radarr" else series_from_proxy(d)


def movie_from_proxy(d: dict) -> dict:
    mr = d.get("MovieRatings") or {}
    certs = {c["Country"]: c["Certification"] for c in d.get("Certifications") or []}

    def r(k, f):
        return (mr.get(k) or {}).get(f)

    return {
        "id": d["TmdbId"], "imdb_id": d.get("ImdbId"), "title": d["Title"],
        "original_title": d.get("OriginalTitle"), "year": d.get("Year"),
        "language": ISO.get(d.get("OriginalLanguage"), d.get("OriginalLanguage")),
        "genres": d.get("Genres") or [], "keywords": d.get("Keywords") or [],
        "studio": d.get("Studio"), "runtime": d.get("Runtime"), "certification": certs.get("US"),
        "popularity": float(d.get("Popularity") or 0),
        "collection": (d.get("Collection") or {}).get("Name"),
        "in_cinemas": d.get("InCinema"), "digital_release": d.get("DigitalRelease"),
        "physical_release": d.get("PhysicalRelease"),
        "imdb_rating": r("Imdb", "Value"), "imdb_votes": r("Imdb", "Count"),
        "tmdb_rating": r("Tmdb", "Value"), "tmdb_votes": r("Tmdb", "Count"),
        "rt_rating": r("RottenTomatoes", "Value"), "metacritic": r("Metacritic", "Value"),
        "trakt_rating": r("Trakt", "Value"), "trakt_votes": r("Trakt", "Count"),
        "tags": [], "has_file": False, "size": 0,
    }


def series_from_proxy(d: dict) -> dict:
    rating = d.get("rating") or {}
    seasons = [s for s in d.get("seasons") or [] if s.get("seasonNumber", 0) > 0]
    episodes = [e for e in d.get("episodes") or [] if e.get("seasonNumber", 0) > 0]
    first = d.get("firstAired")
    return {
        "id": d["tvdbId"], "imdb_id": d.get("imdbId"), "tmdb_id": d.get("tmdbId"), "title": d["title"],
        "year": int(first[:4]) if first else None,
        "language": ISO.get(d.get("originalLanguage"), d.get("originalLanguage")),
        "genres": d.get("genres") or [], "network": d.get("network") or d.get("originalNetwork"),
        "runtime": d.get("runtime"), "certification": d.get("contentRating"),
        "status": (d.get("status") or "").lower() or None, "series_type": "standard",
        "first_aired": first, "last_aired": d.get("lastAired"),
        "rating": float(rating["value"]) if rating.get("value") else None,
        "rating_votes": rating.get("count"), "season_count": len(seasons),
        "episode_count": len(episodes), "tags": [], "size": 0, "has_file": False,
    }
