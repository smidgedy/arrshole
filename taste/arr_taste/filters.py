"""Evaluate the Radarr/Sonarr UI custom filters (CustomFilters table) against corpus rows.

Mirrors the frontend predicate semantics:
  - conditions inside one filter are ANDed
  - a multi-value equal/contains condition matches if ANY value matches;
    notEqual/notContains match only if NONE do
  - missing ratings/votes count as 0 (frontend destructures with `value = 0`)
  - Radarr tmdbRating and Sonarr ratings compare value * 10
"""
from datetime import datetime, timedelta, timezone

import pandas as pd

NOW = datetime.now(timezone.utc)


def _num(x):
    return 0 if x is None or (isinstance(x, float) and pd.isna(x)) else x


def _lst(x):
    return [] if x is None or (isinstance(x, float) and pd.isna(x)) else list(x)


def radarr_release_date(row):
    for k in ("digital_release", "physical_release"):
        if row.get(k):
            return pd.Timestamp(row[k])
    if row.get("in_cinemas"):
        return pd.Timestamp(row["in_cinemas"]) + pd.Timedelta(days=90)
    return None


def field(app, row, key):
    if app == "radarr":
        return {
            "tmdbRating": lambda: _num(row.get("tmdb_rating")) * 10,
            "imdbRating": lambda: _num(row.get("imdb_rating")),
            "imdbVotes": lambda: _num(row.get("imdb_votes")),
            "tmdbVotes": lambda: _num(row.get("tmdb_votes")),
            "rottenTomatoesRating": lambda: _num(row.get("rt_rating")),
            "originalLanguage": lambda: row.get("language"),
            "genres": lambda: _lst(row.get("genres")),
            "tags": lambda: _lst(row.get("tags")),
            "studio": lambda: row.get("studio"),
            "sizeOnDisk": lambda: _num(row.get("size")),
            "releaseDate": lambda: radarr_release_date(row),
        }[key]()
    return {
        "ratings": lambda: _num(row.get("rating")) * 10,
        "ratingVotes": lambda: _num(row.get("rating_votes")),
        "year": lambda: _num(row.get("year")),
        "originalLanguage": lambda: row.get("language"),
        "genres": lambda: _lst(row.get("genres")),
        "tags": lambda: _lst(row.get("tags")),
        "seasonCount": lambda: _num(row.get("season_count")),
        "sizeOnDisk": lambda: _num(row.get("size")),
        "status": lambda: row.get("status"),
    }[key]()


def cond_match(app, row, c):
    v, t = field(app, row, c["key"]), c["type"]
    vals = c["value"]
    if t in ("lessThan", "greaterThan", "lessThanOrEqual", "greaterThanOrEqual"):
        x = vals[0] if isinstance(vals, list) else vals
        return {"lessThan": v < x, "greaterThan": v > x,
                "lessThanOrEqual": v <= x, "greaterThanOrEqual": v >= x}[t]
    if t in ("inLast", "notInLast", "inNext", "notInNext"):
        if v is None:
            return False
        delta = {"days": 1, "weeks": 7, "months": 30.4375, "years": 365.25}[vals["time"]] * vals["value"]
        v = v.tz_localize("UTC") if v.tzinfo is None else v
        in_last = NOW - timedelta(days=delta) <= v <= NOW
        return in_last if t == "inLast" else not in_last
    vals = vals if isinstance(vals, list) else [vals]
    if isinstance(v, list):
        hit = any(x in v for x in vals)
    else:
        hit = any(v == x or (isinstance(v, str) and isinstance(x, str) and v.lower() == x.lower())
                  for x in vals)
    if t in ("equal", "contains"):
        return hit
    if t in ("notEqual", "notContains"):
        return not hit
    raise ValueError(t)


def filter_match(app, row, f, ignore_keep=False):
    conds = [c for c in f["conditions"] if not (ignore_keep and c["key"] == "tags")]
    return all(cond_match(app, row, c) for c in conds)


def filters_hit(app, df, filters):
    """Names of the UI custom filters each row matches (the keep-tag condition is ignored,
    so we see what each rule targets). Unknown filter keys are skipped, not fatal."""
    rows = df.to_dict("records")
    usable = []
    for f in filters:
        try:
            for r in rows[:1]:
                filter_match(app, r, f, ignore_keep=True)
            usable.append(f)
        except (KeyError, ValueError, TypeError):
            pass
    return [[f["name"] for f in usable if filter_match(app, r, f, ignore_keep=True)] for r in rows]
