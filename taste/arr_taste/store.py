"""SQLite store: everything the model has ever seen, plus verdicts and run history.

items       one row per (app, ext_id). state: present | deleted | excluded
junk_seen   which items carried the junk tag when each run observed the library
feedback    explicit verdicts (junk -> keep / deleted / dismissed, review rounds)
scores      last two runs' P(delete), for drift reporting
plextv      owner's plex.tv watch history (incremental)
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
create table if not exists items (
  app text not null, ext_id integer not null, arr_id integer, title text,
  data text not null, state text not null, first_seen text, last_seen text, gone_at text,
  primary key (app, ext_id));
create table if not exists runs (id integer primary key, at text not null, summary text);
create table if not exists junk_seen (run_id integer, app text, ext_id integer,
  primary key (run_id, app, ext_id));
create table if not exists feedback (
  app text not null, ext_id integer not null, title text, verdict text not null,
  source text not null, at text not null, note text,
  unique (app, ext_id, verdict, source));
create table if not exists scores (run_id integer, app text, ext_id integer, p real,
  primary key (run_id, app, ext_id));
create table if not exists plextv (date text, type text, title text, year integer, guid text,
  show_title text, show_guid text, unique (date, guid));
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def commit(self):
        self.db.commit()

    # -------------------------------------------------------------- runs

    def start_run(self) -> int:
        cur = self.db.execute("insert into runs (at) values (?)", (now(),))
        return cur.lastrowid

    def finish_run(self, run_id: int, summary: dict):
        self.db.execute("update runs set summary = ? where id = ?", (json.dumps(summary), run_id))
        # keep two runs of scores/junk observations
        self.db.execute("delete from scores where run_id < ?", (run_id - 1,))
        self.db.execute("delete from junk_seen where run_id < ?", (run_id - 1,))
        self.commit()

    def previous_run(self, run_id: int) -> int | None:
        row = self.db.execute("select max(id) from runs where id < ?", (run_id,)).fetchone()
        return row[0]

    # -------------------------------------------------------------- items

    def sync_library(self, app: str, rows: list[dict]) -> dict:
        """Upsert present items; anything previously present and now missing becomes deleted."""
        t = now()
        seen = set()
        for r in rows:
            seen.add(r["id"])
            self.db.execute("""
                insert into items (app, ext_id, arr_id, title, data, state, first_seen, last_seen)
                values (?, ?, ?, ?, ?, 'present', ?, ?)
                on conflict (app, ext_id) do update set arr_id = excluded.arr_id,
                  title = excluded.title, data = excluded.data, state = 'present',
                  last_seen = excluded.last_seen, gone_at = null
            """, (app, r["id"], r.get("arr_id"), r["title"], json.dumps(r), t, t))
        present = {e for (e,) in self.db.execute(
            "select ext_id from items where app = ? and state = 'present'", (app,))}
        gone = present - seen
        for e in gone:
            self.db.execute("update items set state = 'deleted', gone_at = ? where app = ? and ext_id = ?",
                            (t, app, e))
        return {"present": len(seen), "newly_deleted": len(gone)}

    def known_ids(self, app: str) -> set[int]:
        return {e for (e,) in self.db.execute("select ext_id from items where app = ?", (app,))}

    def add_excluded(self, app: str, row: dict):
        self.db.execute("""
            insert or ignore into items (app, ext_id, title, data, state, first_seen)
            values (?, ?, ?, ?, 'excluded', ?)
        """, (app, row["id"], row["title"], json.dumps(row), now()))

    def items(self, app: str) -> list[dict]:
        out = []
        for ext_id, arr_id, title, data, state in self.db.execute(
                "select ext_id, arr_id, title, data, state from items where app = ?", (app,)):
            d = json.loads(data)
            d.update(id=ext_id, arr_id=arr_id, title=title, state=state)
            out.append(d)
        return out

    # -------------------------------------------------------------- junk + feedback

    def record_junk(self, run_id: int, app: str, ext_ids: set[int]):
        self.db.executemany("insert or ignore into junk_seen values (?, ?, ?)",
                            [(run_id, app, e) for e in ext_ids])

    def junk_at(self, run_id: int | None, app: str) -> set[int]:
        if run_id is None:
            return set()
        return {e for (e,) in self.db.execute(
            "select ext_id from junk_seen where run_id = ? and app = ?", (run_id, app))}

    def add_feedback(self, app: str, ext_id: int, title: str, verdict: str, source: str,
                     at: str | None = None, note: str | None = None) -> bool:
        cur = self.db.execute("""
            insert or ignore into feedback (app, ext_id, title, verdict, source, at, note)
            values (?, ?, ?, ?, ?, ?, ?)
        """, (app, ext_id, title, verdict, source, at or now(), note))
        return cur.rowcount > 0

    def verdicts(self, app: str) -> dict[int, str]:
        """Latest verdict per item."""
        rows = self.db.execute(
            "select ext_id, verdict from feedback where app = ? order by at", (app,)).fetchall()
        return {e: v for e, v in rows}

    # -------------------------------------------------------------- scores

    def save_scores(self, run_id: int, app: str, scores: dict[int, float]):
        self.db.executemany("insert or replace into scores values (?, ?, ?, ?)",
                            [(run_id, app, e, p) for e, p in scores.items()])

    def scores_at(self, run_id: int | None, app: str) -> dict[int, float]:
        if run_id is None:
            return {}
        return dict(self.db.execute(
            "select ext_id, p from scores where run_id = ? and app = ?", (run_id, app)))

    # -------------------------------------------------------------- plex.tv

    def plextv_latest(self) -> str | None:
        return self.db.execute("select max(date) from plextv").fetchone()[0]

    def add_plextv(self, rows: list[dict]) -> int:
        cur = self.db.executemany("""
            insert or ignore into plextv values (:date, :type, :title, :year, :guid, :show_title, :show_guid)
        """, rows)
        return cur.rowcount

    def plextv(self):
        import pandas as pd
        return pd.read_sql("select * from plextv", self.db)
