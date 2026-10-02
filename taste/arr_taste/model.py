"""Taste model: P(you'd delete it) from content metadata, scored out-of-fold, then the junk plan.

File features (size, quality) and watch history are deliberately not model inputs: deleted and
excluded items have neither, so they'd leak the label. Size and plays only enter the ranking.
"""
from __future__ import annotations

import logging

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold

log = logging.getLogger(__name__)
NOTABLE = ("log_imdb_votes", "log_tmdb_votes", "log_trakt_votes", "log_popularity",
           "log_rating_votes", "has_critic_scores")


def _lst(x):
    return [] if x is None or (isinstance(x, float) and np.isnan(x)) else list(x)


def _num(df, col):
    return pd.to_numeric(df[col], errors="coerce") if col in df else pd.Series(np.nan, index=df.index)


def _multi_hot(series, prefix, top_n, min_count):
    counts = pd.Series([v for xs in series for v in _lst(xs)]).value_counts()
    keep = counts[counts >= min_count].index[:top_n]
    return pd.DataFrame({f"{prefix}={k}": series.apply(lambda xs, k=k: int(k in _lst(xs))) for k in keep},
                        index=series.index)


def _one_hot(series, prefix, top_n, min_count=15):
    s = series.fillna("∅").astype(str)
    counts = s.value_counts()
    keep = counts[counts >= min_count].index[:top_n]
    return pd.DataFrame({f"{prefix}={k}": (s == k).astype(int) for k in keep}, index=series.index)


def features(app: str, df: pd.DataFrame, f: dict, now_year: float) -> pd.DataFrame:
    n = f["top_n_categories"]
    X = pd.DataFrame(index=df.index)
    parts = []
    if app == "radarr":
        if f["ratings"]:
            for c in ("imdb_rating", "tmdb_rating", "rt_rating", "metacritic", "trakt_rating"):
                X[c] = _num(df, c).replace(0, np.nan)
        if f["votes"]:
            for c in ("imdb_votes", "tmdb_votes", "trakt_votes"):
                X[f"log_{c}"] = np.log1p(_num(df, c).fillna(0))
            X["log_popularity"] = np.log1p(_num(df, "popularity").fillna(0))
        X["has_critic_scores"] = (_num(df, "rt_rating").fillna(0).gt(0)
                                  | _num(df, "metacritic").fillna(0).gt(0)).astype(int)
        X["in_collection"] = df["collection"].notna().astype(int)
        if f["genres"]:
            parts.append(_multi_hot(df["genres"], "genre", 30, 5))
        if f["studio_network"]:
            parts.append(_one_hot(df["studio"], "studio", n))
        if f["keywords"]:
            parts.append(_multi_hot(df["keywords"], "kw", f["top_n_keywords"], 25))
    else:
        if f["ratings"]:
            X["rating"] = _num(df, "rating").replace(0, np.nan)
        if f["votes"]:
            X["log_rating_votes"] = np.log1p(_num(df, "rating_votes").fillna(0))
        if f["shape"]:
            X["season_count"] = _num(df, "season_count")
            X["log_episode_count"] = np.log1p(_num(df, "episode_count").fillna(0))
            parts.append(_one_hot(df["status"], "status", 4, 1))
            parts.append(_one_hot(df["series_type"], "type", 3, 1))
        if f["genres"]:
            parts.append(_multi_hot(df["genres"], "genre", 35, 5))
        if f["studio_network"]:
            parts.append(_one_hot(df["network"], "network", n))
    if f["release_age"]:
        X["age_years"] = now_year - _num(df, "year")
    if f["runtime"]:
        X["runtime"] = _num(df, "runtime").replace(0, np.nan)
    if f["language"]:
        parts.append(_one_hot(df["language"], "lang", n))
    if f["certification"]:
        parts.append(_one_hot(df["certification"], "cert", 15))
    X = pd.concat([X, *parts], axis=1)
    X.columns = [c.translate(str.maketrans({" ": "_", '"': "", ",": "", ":": "", "[": "", "]": ""}))
                 for c in X.columns]
    return X.loc[:, ~X.columns.duplicated()]


def labels_and_weights(df: pd.DataFrame, w: dict, scale: dict) -> tuple[np.ndarray, np.ndarray, dict]:
    """Base labels from library state, then verdicts on top with a total-weight cap."""
    y = df["state"].isin(["deleted", "excluded"]).astype(int).to_numpy().copy()
    sw = np.select(
        [df["state"] == "deleted", df["state"] == "excluded", df["keep"], df["pending"]],
        [w["deleted"], w["excluded"], w["keep"], w["pending"]],
        default=w["retained"],
    ).astype(float)
    has_v = df["verdict"].notna().to_numpy()
    for i in np.flatnonzero(has_v):
        v = df["verdict"].iat[i]
        y[i] = 0 if v in ("keep", "dismissed") else 1
        sw[i] = w["feedback"] * scale[v]
    fb_total = sw[has_v].sum()
    cap = w["feedback_cap_share"] * sw[~has_v].sum() / (1 - w["feedback_cap_share"])
    capped = fb_total > cap > 0
    if capped:
        sw[has_v] *= cap / fb_total
    return y, sw, {"verdicts": int(has_v.sum()), "feedback_weight": round(float(sw[has_v].sum()), 1),
                   "feedback_capped": bool(capped)}


def describe(col, val):
    if "=" in col:
        k, v = col.split("=", 1)
        return f"{k}={v}" if val else f"not {k}={v}"
    if pd.isna(val):
        return f"{col}=missing"
    if col.startswith("log_"):
        return f"{col[4:]}={np.expm1(val):,.0f}"
    return f"{col}={val:.3g}"


def fit_oof(X: pd.DataFrame, y: np.ndarray, sw: np.ndarray, m: dict):
    params = dict(objective="binary", learning_rate=m["learning_rate"], num_leaves=m["num_leaves"],
                  min_data_in_leaf=m["min_data_in_leaf"], feature_fraction=0.8, bagging_fraction=0.8,
                  bagging_freq=1, lambda_l2=1.0, verbose=-1, seed=m["seed"], num_threads=4)
    if m.get("monotone_notability", True):
        params["monotone_constraints"] = [-1 if c in NOTABLE else 0 for c in X.columns]
        params["monotone_constraints_method"] = "advanced"
    oof = np.zeros(len(X))
    contrib = np.zeros((len(X), X.shape[1] + 1))
    skf = StratifiedKFold(m["folds"], shuffle=True, random_state=m["seed"])
    for tr, te in skf.split(X, y):
        b = lgb.train(params, lgb.Dataset(X.iloc[tr], y[tr], weight=sw[tr]),
                      num_boost_round=m["num_boost_round"])
        oof[te] = b.predict(X.iloc[te])
        contrib[te] = b.predict(X.iloc[te], pred_contrib=True)
    cols, vals = X.columns, X.to_numpy()
    reasons = []
    for i in range(len(X)):
        c = contrib[i, :-1]
        top = np.argsort(-c)[:3]
        reasons.append("; ".join(describe(cols[j], vals[i, j]) for j in top if c[j] > 0.05))
    return oof, reasons


def auc(y, p) -> float | None:
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(y, p)) if len(set(y)) == 2 else None


def plan(app: str, df: pd.DataFrame, cfg: dict, now: pd.Timestamp) -> tuple[pd.DataFrame, list, list]:
    """Returns (ranked candidates, add list, remove list). df: scored items incl. junk flag."""
    c, wg = cfg["candidates"], cfg["watch"]
    n_target = c["junk_movies"] if app == "radarr" else c["junk_series"]
    min_gb = c["min_size_gb_movies"] if app == "radarr" else c["min_size_gb_series"]
    recent = df["last_watched"] >= now - pd.DateOffset(months=wg["protect_months"])
    protected = (df["plays"] >= wg["protect_min_plays"]) & recent
    reviewed_keep = df["verdict"].isin(["keep", "dismissed"])
    present = df["state"] == "present"

    p = df["p_delete"].clip(1e-4, 1 - 1e-4)
    df = df.assign(protected=protected, score=c["taste_weight"] * np.log(p / (1 - p))
                   + c["size_weight"] * np.log(df["size_gb"].clip(lower=0.01))
                   - wg["play_penalty"] * np.log1p(df["plays"]))
    eligible = present & df["has_file"] & ~df["keep"] & ~reviewed_keep & ~protected \
        & (df["size_gb"] >= min_gb)
    cand = df[eligible & (df["p_delete"] >= c["min_p_delete"])].sort_values("score", ascending=False)

    remove = []
    for _, r in df[df["junk"] & present].iterrows():
        why = None
        if r["keep"]:
            why = "marked keep"
        elif r["protected"]:
            why = "watched recently"
        elif not eligible.loc[r.name]:
            why = "no longer eligible"
        elif r["p_delete"] < c["min_p_delete"] - c["hysteresis"]:
            why = f"model changed its mind (P={r['p_delete']:.2f})"
        if why:
            remove.append({"id": int(r["arr_id"]), "ext_id": int(r["id"]), "title": r["title"], "reason": why})
    removed = {x["ext_id"] for x in remove}
    staying = int((df["junk"] & present & ~df["id"].isin(removed)).sum())
    add = []
    for _, r in cand[~cand["junk"]].head(max(0, n_target - staying)).iterrows():
        add.append({"id": int(r["arr_id"]), "ext_id": int(r["id"]), "title": r["title"],
                    "year": None if pd.isna(r.get("year")) else int(r["year"]),
                    "sizeGb": round(float(r["size_gb"]), 1), "pDelete": round(float(r["p_delete"]), 3),
                    "score": round(float(r["score"]), 2), "reasons": r["reasons"]})
    return cand, add, remove
