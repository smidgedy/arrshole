"""Watch stats per library item from Plex.

Sources (all read-only):
  - newest nightly DB backup in [plex].db_dir: play history (metadata_item_views, all
    accounts, includes removed items) + watch state (metadata_item_settings, goes back
    years via plex.tv sync)
  - the owner's plex.tv watch history (community GraphQL), fetched incrementally into the store

Output: {app: DataFrame indexed by ext_id with plays, last_watched, watchers}
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from pathlib import Path

import pandas as pd
import requests

from .store import Store

log = logging.getLogger(__name__)
MOVIE, EPISODE = 1, 4
SCHEME = {"radarr": "tmdb", "sonarr": "tvdb"}


def newest_backup(db_dir: str) -> Path | None:
    d = Path(db_dir)
    if not d.is_dir():
        return None
    backups = sorted(d.glob("com.plexapp.plugins.library.db-20*"))
    backups = [b for b in backups if not b.name.endswith("-tmp") and b.stat().st_size > 0]
    return backups[-1] if backups else None


def _ext_ids(con) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for guid, tag in con.execute("""
        select mi.guid, t.tag from metadata_items mi
        join taggings tg on tg.metadata_item_id = mi.id
        join tags t on t.id = tg.tag_id and t.tag_type = 314
        where mi.metadata_type in (1, 2)"""):
        scheme, _, val = tag.partition("://")
        out.setdefault(guid, {})[scheme] = val
    return out


def _from_db(path: Path) -> tuple[pd.DataFrame, dict]:
    # immutable: the backup is never written again, and this avoids lock files on /mnt/c
    con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    accounts = dict(con.execute("select id, name from accounts"))
    ids = _ext_ids(con)
    views = pd.read_sql("""
        select account_id, metadata_type,
               case metadata_type when 4 then grandparent_guid else guid end as item_guid,
               case metadata_type when 4 then grandparent_title else title end as item_title,
               viewed_at as at, 1 as plays
        from metadata_item_views where metadata_type in (1, 4)""", con)
    state = pd.read_sql("""
        select s.account_id, mi.metadata_type,
               coalesce(gp.guid, mi.guid) as item_guid, coalesce(gp.title, mi.title) as item_title,
               s.last_viewed_at as at, s.view_count as plays
        from metadata_item_settings s
        join metadata_items mi on mi.guid = s.guid and mi.metadata_type in (1, 4)
        left join metadata_items p on mi.metadata_type = 4 and p.id = mi.parent_id
        left join metadata_items gp on gp.id = p.parent_id
        where s.view_count > 0""", con)
    # watch state already counts plays the history table has, so per (account, item) take
    # whichever source counts more rather than adding them
    keys = ["account_id", "metadata_type", "item_guid"]
    by_src = pd.concat([views.assign(src="views"), state.assign(src="state")]).groupby(
        keys + ["src"]).agg(plays=("plays", "sum"), at=("at", "max"), item_title=("item_title", "first"))
    per = by_src.groupby(keys).agg(plays=("plays", "max"), at=("at", "max"),
                                   item_title=("item_title", "first")).reset_index()
    per["account"] = per["account_id"].map(accounts).fillna(per["account_id"].astype(str))
    per["at"] = pd.to_datetime(per["at"], unit="s")
    return per, ids


def sync_plextv(store: Store, token: str):
    """Fetch plex.tv history newest-first until we reach what we already have."""
    h = {"X-Plex-Token": token, "Accept": "application/json", "Content-Type": "application/json",
         "X-Plex-Client-Identifier": "arrshole-taste", "X-Plex-Product": "arrshole"}
    q = """query GetWatchHistoryHub($uuid: ID = "", $first: PaginationInt!, $after: String) {
      user(id: $uuid) { watchHistory(first: $first, after: $after) {
        nodes { date metadataItem { title type year guid grandparent { title guid } } }
        pageInfo { hasNextPage endCursor } } } }"""
    uuid = requests.get("https://plex.tv/api/v2/user", headers=h, timeout=20).json()["uuid"]
    latest = store.plextv_latest()
    after, added = None, 0
    while True:
        for attempt in range(8):
            try:
                r = requests.post("https://community.plex.tv/api", headers=h, timeout=60, json={
                    "query": q, "variables": {"uuid": uuid, "first": 100, "after": after}})
                if r.status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(min(60, 3 * 2 ** attempt))
        r.raise_for_status()
        wh = r.json()["data"]["user"]["watchHistory"]
        rows = []
        for n in wh["nodes"]:
            m = n["metadataItem"] or {}
            gp = m.get("grandparent") or {}
            rows.append({"date": n["date"], "type": m.get("type"), "title": m.get("title"),
                         "year": m.get("year"), "guid": m.get("guid"),
                         "show_title": gp.get("title"), "show_guid": gp.get("guid")})
        added += store.add_plextv(rows)
        reached_known = latest is not None and rows and min(x["date"] for x in rows) <= latest
        if reached_known or not wh["pageInfo"]["hasNextPage"]:
            break
        after = wh["pageInfo"]["endCursor"]
        time.sleep(0.6)
    store.commit()
    log.info("plex.tv history: %d new events", added)


def watch_stats(store: Store, cfg: dict, titles: dict[str, dict[str, int]]) -> dict[str, pd.DataFrame]:
    """titles: {app: {lowercased title: ext_id}} for matching items Plex can't id."""
    frames = []
    ids: dict = {}
    path = newest_backup(cfg.get("db_dir") or "")
    if path:
        per, ids = _from_db(path)
        frames.append(per)
        log.info("plex db %s: %d (account, item) rows", path.name, len(per))
    else:
        log.warning("no Plex DB backup found in %r; skipping server watch stats", cfg.get("db_dir"))

    token = os.environ.get("PLEX_TOKEN")
    if cfg.get("plextv_history") and token:
        try:
            sync_plextv(store, token)
        except Exception:  # noqa: BLE001 — history is a bonus signal; never fail the run on it
            log.exception("plex.tv history sync failed; using what's stored")
    h = store.plextv()
    if len(h):
        mv = h[h["type"] == "MOVIE"].assign(metadata_type=MOVIE, item_guid=lambda d: d["guid"],
                                             item_title=lambda d: d["title"])
        ep = h[h["type"] == "EPISODE"].assign(metadata_type=EPISODE, item_guid=lambda d: d["show_guid"],
                                               item_title=lambda d: d["show_title"])
        tv = pd.concat([mv, ep])
        tv["at"] = pd.to_datetime(tv["date"], utc=True).dt.tz_localize(None)
        frames.append(tv.groupby(["metadata_type", "item_guid", "item_title"]).agg(
            plays=("date", "size"), at=("at", "max")).reset_index().assign(account="owner (plex.tv)"))

    out = {}
    if not frames:
        return {app: pd.DataFrame(columns=["plays", "last_watched", "watchers"]) for app in SCHEME}
    allw = pd.concat(frames, ignore_index=True)
    for app, mtype in (("radarr", MOVIE), ("sonarr", EPISODE)):
        w = allw[allw["metadata_type"] == mtype].copy()
        w["ext_id"] = w["item_guid"].map(lambda g: (ids.get(g) or {}).get(SCHEME[app]))
        w["ext_id"] = pd.to_numeric(w["ext_id"], errors="coerce")
        miss = w["ext_id"].isna()
        w.loc[miss, "ext_id"] = w.loc[miss, "item_title"].str.lower().map(titles.get(app, {}))
        w = w.dropna(subset=["ext_id"])
        w["ext_id"] = w["ext_id"].astype(int)
        out[app] = w.groupby("ext_id").agg(
            plays=("plays", "sum"), last_watched=("at", "max"),
            watchers=("account", lambda s: ", ".join(sorted(set(s)))))
    return out
