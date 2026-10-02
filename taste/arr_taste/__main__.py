"""arr_taste — learns keep/delete taste from Radarr/Sonarr and plans `junk` tags.

  python -m arr_taste plan   read library, record verdicts, retrain, print the tag plan (JSON) on stdout
  python -m arr_taste seed FILE.jsonl   import historic deletions/exclusions/verdicts (one-off)

Never writes to Radarr/Sonarr: arrshole applies the plan (and owns dry-run and caps).
Logs go to stderr; stdout carries only the plan JSON.

Env: RADARR_URL, RADARR_API_KEY, SONARR_URL, SONARR_API_KEY, PLEX_TOKEN (optional),
     TASTE_DATA_DIR (default ../taste-data), TASTE_CONFIG (default taste.toml next to the package)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import tomllib
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import metadata
from .arr import Arr
from .filters import filters_hit
from .model import auc, features, fit_oof, labels_and_weights, plan
from .plex import watch_stats
from .store import Store

log = logging.getLogger("arr_taste")
PKG = Path(__file__).resolve().parent
APPS = ("radarr", "sonarr")
MAX_EXCLUSION_FETCH = 400   # per app per run; the backlog drains over a few runs


def load_cfg() -> dict:
    return tomllib.loads(Path(os.environ.get("TASTE_CONFIG", PKG.parent / "taste.toml")).read_text())


def data_dir() -> Path:
    return Path(os.environ.get("TASTE_DATA_DIR", "../taste-data")).resolve()


def configured_apps() -> dict[str, Arr]:
    out = {}
    for app in APPS:
        url, key = os.environ.get(f"{app.upper()}_URL"), os.environ.get(f"{app.upper()}_API_KEY")
        if url and key:
            out[app] = Arr(app, url, key)
    return out


def refresh(store: Store, run_id: int, prev_run: int | None, app: str, arr: Arr, cfg: dict) -> dict:
    tags = arr.tags()
    keep_id, junk_id = tags.get(cfg["tags"]["keep"].lower()), tags.get(cfg["tags"]["junk"].lower())
    rows = arr.library()
    sync = store.sync_library(app, rows)

    # exclusions we've never seen as library items: fetch their metadata (bounded per run)
    known = store.known_ids(app)
    todo = [e for e in arr.exclusions() if e["id"] not in known][:MAX_EXCLUSION_FETCH]
    s = requests.Session()
    s.headers["User-Agent"] = "arrshole-taste"
    fetched = 0
    for e in todo:
        try:
            d = metadata.fetch(app, e["id"], s)
        except RuntimeError:
            log.warning("%s: metadata fetch failed for exclusion %s", app, e["id"])
            continue
        if d:
            store.add_excluded(app, metadata.to_row(app, d))
            fetched += 1

    # verdicts: compare what carried `junk` last run with what we see now
    junk_now = {r["id"] for r in rows if junk_id in r["tags"]} if junk_id else set()
    present = {r["id"]: r for r in rows}
    titles = {i["id"]: i["title"] for i in store.items(app)}
    new_verdicts = 0
    for e in store.junk_at(prev_run, app):
        r = present.get(e)
        if r is None:
            v = "delete"
        elif keep_id in r["tags"]:
            v = "keep"
        elif e not in junk_now:
            v = "dismissed"
        else:
            continue
        new_verdicts += store.add_feedback(app, e, titles.get(e, ""), v, "junk")
    store.record_junk(run_id, app, junk_now)
    store.commit()
    return {**sync, "exclusions_fetched": fetched, "exclusions_pending": max(0, len(todo) - fetched),
            "new_verdicts": new_verdicts, "junk_tagged_now": len(junk_now),
            "keep_tag_id": keep_id, "filters": arr.custom_filters()}


def score_app(store: Store, run_id: int, prev_run: int | None, app: str, info: dict, cfg: dict,
              watch: pd.DataFrame, junk_label: str, junk_id: int | None):
    df = pd.DataFrame(store.items(app)).reset_index(drop=True)
    for col in ("tags", "genres", "keywords"):
        if col in df:
            df[col] = df[col].apply(lambda x: x if isinstance(x, list) else [])
    keep_id = info["keep_tag_id"]
    present = df["state"] == "present"
    df["keep"] = present & df["tags"].apply(lambda t: keep_id in t)
    df["junk"] = present & df["tags"].apply(lambda t: junk_id is not None and junk_id in t)
    df["verdict"] = df["id"].map(store.verdicts(app))
    hits = filters_hit(app, df, info["filters"])
    df["pending"] = present & ~df["keep"] & pd.Series([len(h) > 0 for h in hits]) & df["verdict"].isna()
    df["size_gb"] = pd.to_numeric(df["size"], errors="coerce").fillna(0) / 1e9
    df["has_file"] = df["has_file"].fillna(False).astype(bool)
    df = df.join(watch, on="id")
    df["plays"] = df["plays"].fillna(0).astype(int)
    df["watchers"] = df["watchers"].fillna("")

    now = pd.Timestamp.now()
    X = features(app, df, cfg["features"], now.year + now.dayofyear / 365)
    y, sw, wstats = labels_and_weights(df, cfg["weights"], cfg["verdict_scale"])
    oof, reasons = fit_oof(X, y, sw, cfg["model"])
    df["p_delete"], df["reasons"] = oof, reasons

    scores = dict(zip(df.loc[present, "id"].astype(int), df.loc[present, "p_delete"]))
    prev = store.scores_at(prev_run, app)
    common = [e for e in scores if e in prev]
    drift = None
    if common:
        delta = np.array([scores[e] - prev[e] for e in common])
        thr = cfg["candidates"]["min_p_delete"]
        drift = {"mean_abs_change": round(float(np.abs(delta).mean()), 4),
                 "crossed_threshold": int(sum((scores[e] >= thr) != (prev[e] >= thr) for e in common))}
    store.save_scores(run_id, app, scores)

    cand, add, remove = plan(app, df, cfg, now)
    clean = present & ~df["pending"]
    metrics = {"auc": auc(y, oof),
               "auc_deleted_vs_clean": auc(y[(df["state"] == "deleted") | clean],
                                           oof[(df["state"] == "deleted") | clean]),
               "items": int(len(df)), "by_state": df["state"].value_counts().to_dict(),
               **wstats, "drift": drift, "candidates": int(len(cand))}

    out = data_dir() / "runs" / str(run_id)
    out.mkdir(parents=True, exist_ok=True)
    cols = ["title", "year", "size_gb", "p_delete", "score", "plays", "watchers", "reasons", "junk"]
    cand[cols].to_csv(out / f"{app}_candidates.csv", index=False)
    return {"tagLabel": junk_label, "add": add, "remove": remove, "metrics": metrics}


def cmd_plan() -> dict:
    cfg = load_cfg()
    apps = configured_apps()
    if not apps:
        raise SystemExit("no *arr configured (RADARR_URL/RADARR_API_KEY, SONARR_URL/SONARR_API_KEY)")
    store = Store(data_dir() / "taste.db")
    run_id = store.start_run()
    prev_run = store.previous_run(run_id)
    infos, junk_ids = {}, {}
    for app, arr in apps.items():
        infos[app] = refresh(store, run_id, prev_run, app, arr, cfg)
        junk_ids[app] = arr.tags().get(cfg["tags"]["junk"].lower())
        log.info("%s: %s", app, {k: v for k, v in infos[app].items() if k != "filters"})

    titles = {app: {i["title"].lower(): i["id"] for i in store.items(app)} for app in apps}
    watch = watch_stats(store, cfg.get("plex", {}), titles)

    result = {"runId": run_id, "apps": {}}
    for app in apps:
        result["apps"][app] = score_app(store, run_id, prev_run, app, infos[app], cfg,
                                        watch.get(app, pd.DataFrame(columns=["plays", "last_watched", "watchers"])),
                                        cfg["tags"]["junk"], junk_ids[app])
        log.info("%s: %s", app, result["apps"][app]["metrics"])
    store.finish_run(run_id, {a: r["metrics"] for a, r in result["apps"].items()})
    (data_dir() / "runs" / str(run_id) / "plan.json").write_text(json.dumps(result, indent=1, default=str))
    return result


def cmd_seed(path: str) -> dict:
    """JSONL rows: {"kind": "item", "app", "state": "deleted"|"excluded", "data": {...}}
                   {"kind": "verdict", "app", "ext_id", "title", "verdict", "note"?}"""
    store = Store(data_dir() / "taste.db")
    counts = {"items": 0, "verdicts": 0}
    for line in Path(path).read_text().splitlines():
        r = json.loads(line)
        if r["kind"] == "item":
            d = r["data"]
            store.db.execute("""insert or ignore into items (app, ext_id, title, data, state, first_seen, gone_at)
                                values (?, ?, ?, ?, ?, ?, ?)""",
                             (r["app"], d["id"], d["title"], json.dumps(d), r["state"],
                              r.get("first_seen"), r.get("gone_at")))
            counts["items"] += 1
        else:
            counts["verdicts"] += store.add_feedback(r["app"], r["ext_id"], r["title"], r["verdict"],
                                                     "review", r.get("at"), r.get("note"))
    store.commit()
    return counts


def main(argv: list[str]) -> int:
    logging.basicConfig(level=os.environ.get("TASTE_LOG_LEVEL", "INFO"), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cmd = argv[0] if argv else "plan"
    if cmd == "plan":
        print(json.dumps(cmd_plan(), default=str))
    elif cmd == "seed" and len(argv) == 2:
        print(json.dumps(cmd_seed(argv[1])))
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
