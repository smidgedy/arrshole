import numpy as np
import pandas as pd
import pytest

from arr_taste.__main__ import refresh
from arr_taste.filters import filters_hit
from arr_taste.model import features, fit_oof, labels_and_weights, plan
from arr_taste.store import Store

W = {"deleted": 2.0, "excluded": 1.0, "keep": 4.0, "pending": 0.25, "retained": 1.0,
     "feedback": 3.0, "feedback_cap_share": 0.15}
SCALE = {"delete": 1.0, "probably": 0.6, "possibly": 0.3, "keep": 1.0, "dismissed": 0.5}
MODEL = {"folds": 5, "seed": 7, "num_boost_round": 150, "learning_rate": 0.05, "num_leaves": 15,
         "min_data_in_leaf": 20, "monotone_notability": True}
FEATS = {"ratings": True, "votes": True, "release_age": False, "runtime": True, "genres": True,
         "language": True, "certification": True, "studio_network": True, "keywords": True,
         "shape": True, "top_n_categories": 40, "top_n_keywords": 150}


def frame(n, **cols):
    base = {"state": ["present"] * n, "keep": [False] * n, "pending": [False] * n, "verdict": [None] * n}
    base.update(cols)
    return pd.DataFrame(base)


# ------------------------------------------------------------------ weights

def test_verdicts_override_labels_and_scale_weights():
    n = 104   # enough unreviewed weight that the cap doesn't kick in
    df = frame(n, state=["present", "present", "deleted", "present"] + ["present"] * (n - 4),
               verdict=[None, "keep", "keep", "possibly"] + [None] * (n - 4))
    y, sw, stats = labels_and_weights(df, W, SCALE)
    assert list(y[:4]) == [0, 0, 0, 1]      # deleted item marked keep by verdict -> 0
    assert list(sw[:4]) == pytest.approx([1.0, 3.0, 3.0, 0.9])
    assert stats["verdicts"] == 3 and not stats["feedback_capped"]


def test_feedback_weight_is_capped_as_share_of_total():
    df = frame(100, verdict=[None] * 80 + ["keep"] * 20)   # 20 verdicts * 3.0 = 60 vs 80 base
    _, sw, stats = labels_and_weights(df, W, SCALE)
    share = sw[80:].sum() / sw.sum()
    assert stats["feedback_capped"]
    assert share == pytest.approx(0.15, abs=1e-6)


# ------------------------------------------------------------------ one odd keep doesn't swing the model

def test_one_odd_keep_is_ignored_but_a_consistent_run_of_keeps_moves_the_model():
    """1,200 films; Estonian ones were all deleted except 40 still in the library.
    One Estonian film marked keep (the 'Estonian horse drama') must not rescue the others;
    25 of them marked keep is a real pattern and should."""
    rng = np.random.default_rng(1)
    n = 1200
    lang = np.where(np.arange(n) < 200, "Estonian", "English")
    state = np.where(lang == "Estonian", "deleted", np.where(rng.random(n) < 0.08, "deleted", "present"))
    state[:40] = "present"
    df = pd.DataFrame({
        "id": np.arange(n), "state": state, "language": lang,
        "genres": [["Drama"]] * n, "keywords": [[]] * n, "studio": None, "collection": None,
        "certification": None, "imdb_rating": rng.normal(6.5, 1, n), "imdb_votes": rng.integers(1e3, 1e5, n),
        "tmdb_rating": np.nan, "tmdb_votes": np.nan, "rt_rating": np.nan, "metacritic": np.nan,
        "trakt_rating": np.nan, "trakt_votes": np.nan, "popularity": 5.0, "runtime": 100, "year": 2015,
        "keep": False, "pending": False, "verdict": None,
    })
    X = features("radarr", df, FEATS, 2026.75)
    others = list(range(30, 40))      # Estonian titles nobody gives a verdict on

    def p_others(keeps):
        d = df.copy()
        d.loc[list(keeps), "verdict"] = "keep"
        y, sw, _ = labels_and_weights(d, W, SCALE)
        p, _ = fit_oof(X, y, sw, MODEL)
        return p[others].mean()

    baseline = p_others([])
    assert baseline > 0.7
    assert abs(p_others([0]) - baseline) < 0.02
    assert baseline - p_others(range(25)) > 0.05


# ------------------------------------------------------------------ plan

CFG = {"candidates": {"taste_weight": 1.0, "size_weight": 0.6, "min_p_delete": 0.35,
                      "min_size_gb_movies": 4, "min_size_gb_series": 10, "junk_movies": 3,
                      "junk_series": 3, "hysteresis": 0.10},
       "watch": {"protect_min_plays": 1, "protect_months": 12, "play_penalty": 1.0}}


def scored(**over):
    n = 6
    d = {"id": range(n), "arr_id": range(100, 100 + n), "title": [f"t{i}" for i in range(n)],
         "year": 2020, "state": "present", "has_file": True, "keep": False, "junk": False,
         "verdict": None, "size_gb": 10.0, "plays": 0, "last_watched": pd.NaT,
         "p_delete": [0.9, 0.8, 0.7, 0.6, 0.3, 0.1], "reasons": ""}
    d.update(over)
    return pd.DataFrame(d)


def test_plan_fills_to_target_and_skips_keep_and_watched():
    df = scored(keep=[True, False, False, False, False, False],
                plays=[0, 5, 0, 0, 0, 0],
                last_watched=[pd.NaT, pd.Timestamp("2026-09-01"), pd.NaT, pd.NaT, pd.NaT, pd.NaT])
    _, add, remove = plan("radarr", df, CFG, pd.Timestamp("2026-10-03"))
    assert [a["ext_id"] for a in add] == [2, 3]     # 0 kept, 1 watched, 4/5 below threshold
    assert remove == []


def test_plan_tops_up_and_removes_with_hysteresis():
    df = scored(junk=[False, True, True, True, False, False], keep=[False, True, False, False, False, False],
                p_delete=[0.9, 0.8, 0.30, 0.20, 0.3, 0.1])
    _, add, remove = plan("radarr", df, CFG, pd.Timestamp("2026-10-03"))
    reasons = {r["ext_id"]: r["reason"] for r in remove}
    assert reasons[1] == "marked keep"
    assert 2 not in reasons                       # 0.30 is within hysteresis of 0.35
    assert reasons[3].startswith("model changed its mind")
    # 1 junk stays (2), target 3 -> room for 2, but only item 0 clears min_p_delete
    assert [a["ext_id"] for a in add] == [0]


# ------------------------------------------------------------------ store + verdict detection

class FakeArr:
    def __init__(self, rows, tags):
        self.rows, self._tags = rows, tags

    def tags(self):
        return self._tags

    def library(self):
        return self.rows

    def exclusions(self):
        return []

    def custom_filters(self):
        return []


def row(i, tags=()):
    return {"id": i, "arr_id": 100 + i, "title": f"t{i}", "tags": list(tags), "genres": [], "size": 1}


def test_verdicts_are_derived_from_junk_tag_changes(tmp_path):
    store = Store(tmp_path / "t.db")
    cfg = {"tags": {"junk": "junk", "keep": "keep"}}
    tags = {"keep": 1, "junk": 2}
    r1 = store.start_run()
    refresh(store, r1, None, "radarr",
            FakeArr([row(1, [2]), row(2, [2]), row(3, [2]), row(4, [2]), row(5)], tags), cfg)
    store.finish_run(r1, {})
    r2 = store.start_run()
    # 1 deleted; 2 marked keep (junk still on); 3 junk removed, no keep; 4 untouched
    info = refresh(store, r2, r1, "radarr",
                   FakeArr([row(2, [1, 2]), row(3), row(4, [2]), row(5)], tags), cfg)
    assert info["newly_deleted"] == 1
    assert store.verdicts("radarr") == {1: "delete", 2: "keep", 3: "dismissed"}
    assert {i["id"]: i["state"] for i in store.items("radarr")}[1] == "deleted"


# ------------------------------------------------------------------ filters

def test_filters_match_ui_semantics():
    df = pd.DataFrame({"language": ["Estonian", "English"], "tags": [[], [1]], "genres": [[], []],
                       "imdb_votes": [100, 100]})
    flt = [{"id": 1, "name": "Lang", "conditions": [
        {"key": "originalLanguage", "value": ["English", "Japanese"], "type": "notEqual"},
        {"key": "tags", "value": [1], "type": "notContains"}]},
           {"id": 2, "name": "Bogus", "conditions": [{"key": "nope", "value": [1], "type": "equal"}]}]
    assert filters_hit("radarr", df, flt) == [["Lang"], []]
