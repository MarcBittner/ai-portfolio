"""SQLite time-series store + the analytics queries that turn logged traffic into
ranked, evidence-backed savings opportunities.

Two tables do the work:

* ``events`` — one row per proxied request: what was asked, what was served, which
  strategy applied, tokens, the baseline vs realized cost, and the savings. This is
  what the over-time reports and the realized-savings proof read from.
* ``quality_samples`` — one row per shadow comparison: the *measured* retained
  quality of a candidate vs the baseline for a task class. Routing rules are only
  generated from these.

Nothing here stores prompt/response bodies — only hashes, token counts, and
metrics — so the proxy is safe to run inline on real traffic.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading

from .cache import MIN_CACHEABLE_PREFIX_TOKENS
from .cost import CACHE_READ_FACTOR

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL, mode TEXT, task_class TEXT,
  requested_model TEXT, served_model TEXT, strategy TEXT,
  in_tokens INTEGER, out_tokens INTEGER, cached_in_tokens INTEGER,
  baseline_cost REAL, served_cost REAL, saved REAL, latency_ms REAL,
  cache_hit INTEGER, deterministic INTEGER,
  request_key TEXT, prefix_hash TEXT, prefix_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS quality_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL, task_class TEXT, baseline_model TEXT, candidate_model TEXT,
  retained REAL, method TEXT, confidence REAL, judge_score REAL,
  baseline_cost REAL, candidate_cost REAL, saved REAL,
  in_tokens INTEGER, out_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_q_task ON quality_samples(task_class);
"""


class Store:
    def __init__(self, path: str | None = None):
        self.path = path or os.environ.get("ARBITER_DB", "arbiter.db")
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # WAL mode: readers always see a consistent snapshot without blocking writers.
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    # ---- writes -----------------------------------------------------------
    def log_event(self, **kw) -> None:
        cols = ("ts", "mode", "task_class", "requested_model", "served_model",
                "strategy", "in_tokens", "out_tokens", "cached_in_tokens",
                "baseline_cost", "served_cost", "saved", "latency_ms", "cache_hit",
                "deterministic", "request_key", "prefix_hash", "prefix_tokens")
        vals = [kw.get(c) for c in cols]
        with self._lock:
            self._db.execute(
                f"INSERT INTO events ({','.join(cols)}) "
                f"VALUES ({','.join('?' * len(cols))})", vals)
            self._db.commit()

    def log_quality(self, **kw) -> None:
        cols = ("ts", "task_class", "baseline_model", "candidate_model", "retained",
                "method", "confidence", "judge_score", "baseline_cost",
                "candidate_cost", "saved", "in_tokens", "out_tokens")
        vals = [kw.get(c) for c in cols]
        with self._lock:
            self._db.execute(
                f"INSERT INTO quality_samples ({','.join(cols)}) "
                f"VALUES ({','.join('?' * len(cols))})", vals)
            self._db.commit()

    def set_meta(self, key: str, value) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)))
            self._db.commit()

    def get_meta(self, key: str, default=None):
        row = self._db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def reset(self) -> None:
        with self._lock:
            self._db.execute("DELETE FROM events")
            self._db.execute("DELETE FROM quality_samples")
            self._db.commit()

    # ---- reads / analytics ------------------------------------------------
    def _where(self, since: float | None) -> tuple[str, list]:
        return (" WHERE ts >= ?", [since]) if since else ("", [])

    def summary(self, since: float | None = None) -> dict:
        w, args = self._where(since)
        row = self._db.execute(
            f"SELECT COUNT(*) n, COALESCE(SUM(baseline_cost),0) base, "
            f"COALESCE(SUM(served_cost),0) served, COALESCE(SUM(saved),0) saved, "
            f"COALESCE(AVG(latency_ms),0) lat, "
            f"COALESCE(SUM(cache_hit),0) hits FROM events{w}", args).fetchone()
        by_strat = {
            r["strategy"]: {"n": r["n"], "saved": round(r["s"], 6)}
            for r in self._db.execute(
                f"SELECT strategy, COUNT(*) n, COALESCE(SUM(saved),0) s "
                f"FROM events{w} GROUP BY strategy", args)
        }
        base = row["base"] or 0.0
        saved = row["saved"] or 0.0
        # quality-weighted: realized retained quality on routed requests
        qw = self._db.execute(
            "SELECT COALESCE(AVG(retained),1.0) q FROM quality_samples"
            + (" WHERE ts >= ?" if since else ""), args).fetchone()
        return {
            "requests": row["n"],
            "baseline_cost": round(base, 6),
            "served_cost": round(row["served"] or 0.0, 6),
            "saved": round(saved, 6),
            "saved_pct": round(100 * saved / base, 2) if base else 0.0,
            "avg_latency_ms": round(row["lat"], 1),
            "cache_hits": row["hits"],
            "avg_retained_quality": round(qw["q"], 4),
            "by_strategy": by_strat,
        }

    def by_task(self, since: float | None = None) -> list[dict]:
        w, args = self._where(since)
        return [dict(r) for r in self._db.execute(
            f"SELECT task_class, COUNT(*) n, COALESCE(SUM(baseline_cost),0) base, "
            f"COALESCE(SUM(saved),0) saved FROM events{w} "
            f"GROUP BY task_class ORDER BY base DESC", args)]

    def timeseries(self, buckets: int = 20, since: float | None = None) -> list[dict]:
        w, args = self._where(since)
        rng = self._db.execute(
            f"SELECT MIN(ts) a, MAX(ts) b FROM events{w}", args).fetchone()
        if not rng or rng["a"] is None:
            return []
        a, b = rng["a"], rng["b"]
        span = max(1e-6, b - a)
        width = span / buckets
        # Single GROUP BY query: assign each row to a bucket by integer division,
        # clamp to [0, buckets-1] so the last timestamp lands in the final bucket.
        bucket_expr = (
            f"MIN(CAST((ts - {a}) / {width} AS INTEGER), {buckets - 1})"
        )
        rows = {
            r["bucket"]: r
            for r in self._db.execute(
                f"SELECT {bucket_expr} AS bucket, "
                f"COUNT(*) n, COALESCE(SUM(baseline_cost),0) base, "
                f"COALESCE(SUM(served_cost),0) served, COALESCE(SUM(saved),0) saved "
                f"FROM events{w} GROUP BY {bucket_expr}",
                args,
            )
        }
        return [
            {
                "bucket": i,
                "requests": rows[i]["n"] if i in rows else 0,
                "baseline_cost": round(rows[i]["base"], 6) if i in rows else 0.0,
                "served_cost": round(rows[i]["served"], 6) if i in rows else 0.0,
                "saved": round(rows[i]["saved"], 6) if i in rows else 0.0,
            }
            for i in range(buckets)
        ]

    def quality_stats(self) -> list[dict]:
        """Per (task, baseline, candidate): n, mean retained, mean $ saved/req."""
        return [dict(
            task_class=r["task_class"], baseline_model=r["baseline_model"],
            candidate_model=r["candidate_model"], n=r["n"],
            retained=round(r["retained"], 4),
            saved_per_req=round(r["saved"], 6),
            avg_in=round(r["ain"] or 0), avg_out=round(r["aout"] or 0),
            confidence=round(r["conf"], 3))
            for r in self._db.execute(
            "SELECT task_class, baseline_model, candidate_model, COUNT(*) n, "
            "AVG(retained) retained, AVG(saved) saved, AVG(confidence) conf, "
            "AVG(in_tokens) ain, AVG(out_tokens) aout "
            "FROM quality_samples GROUP BY task_class, baseline_model, "
            "candidate_model HAVING n >= 1")]

    # representative published $/Mtok scenarios for the price projection
    PRICE_SCENARIOS = {
        "frontier-to-local": {"label": "Opus → local", "base": (15.0, 75.0),
                              "cand": (0.0, 0.0)},
        "sonnet-to-haiku": {"label": "Sonnet → Haiku", "base": (3.0, 15.0),
                            "cand": (1.0, 5.0)},
        "gpt4o-to-mini": {"label": "GPT-4o → 4o-mini", "base": (2.5, 10.0),
                          "cand": (0.15, 0.60)},
    }

    def projection(self, cfg, scenario: str = "sonnet-to-haiku") -> dict:
        """Project the *measured* routing decisions onto a chosen list-price
        scenario. The quality retention is real; this just re-prices the measured
        token counts so you can see the dollar impact at prices you actually pay."""
        sc = self.PRICE_SCENARIOS.get(scenario, self.PRICE_SCENARIOS["sonnet-to-haiku"])
        (bi, bo), (ci, co) = sc["base"], sc["cand"]
        counts = self.task_counts()
        per_task, total = [], 0.0
        best: dict[str, dict] = {}
        for s in self.quality_stats():
            if s["n"] < cfg.min_samples or s["retained"] < cfg.floor:
                continue
            saved_req = (s["avg_in"] * (bi - ci) + s["avg_out"] * (bo - co)) / 1e6
            if saved_req <= 0:
                continue
            value = saved_req - cfg.rate * (1.0 - s["retained"])
            if s["task_class"] not in best or value > best[s["task_class"]]["_v"]:
                best[s["task_class"]] = {**s, "saved_req": saved_req, "_v": value}
        for task, s in best.items():
            n = counts.get(task, s["n"])
            amt = round(s["saved_req"] * n, 6)
            total += amt
            per_task.append({"task_class": task, "to_model": s["candidate_model"],
                             "retained_quality": s["retained"],
                             "saved_per_req": round(s["saved_req"], 6),
                             "requests": n, "savings": amt})
        per_task.sort(key=lambda x: x["savings"], reverse=True)
        return {"scenario": scenario, "label": sc["label"],
                "base_price": sc["base"], "cand_price": sc["cand"],
                "total_savings": round(total, 6), "per_task": per_task}

    def task_counts(self) -> dict[str, int]:
        return {r["task_class"]: r["n"] for r in self._db.execute(
            "SELECT task_class, COUNT(*) n FROM events GROUP BY task_class")}

    # ---- opportunities (all three strategies) -----------------------------
    def route_opportunities(self, cfg) -> list[dict]:
        counts = self.task_counts()
        out = []
        # pick the best floor-clearing candidate per (task, baseline)
        best: dict[tuple, dict] = {}
        for s in self.quality_stats():
            if s["n"] < cfg.min_samples or s["retained"] < cfg.floor:
                continue
            value = s["saved_per_req"] - cfg.rate * (1.0 - s["retained"])
            k = (s["task_class"], s["baseline_model"])
            if k not in best or value > best[k]["_value"]:
                best[k] = {**s, "_value": value}
        for (task, baseline), s in best.items():
            if s["saved_per_req"] <= 0:
                continue
            n = counts.get(task, s["n"])
            out.append({
                "kind": "route",
                "task_class": task,
                "from_model": baseline,
                "to_model": s["candidate_model"],
                "retained_quality": s["retained"],
                "quality_impact": round(s["retained"] - 1.0, 4),
                "savings": round(s["saved_per_req"] * n, 6),
                "saved_per_req": s["saved_per_req"],
                "samples": s["n"],
                "confidence": s["confidence"],
                "measured": True,
                "detail": (f"route {task} {baseline}→{s['candidate_model']} at "
                           f"{s['retained'] * 100:.0f}% retained quality "
                           f"(n={s['n']})"),
            })
        return out

    def prompt_cache_opportunities(self, reg) -> list[dict]:
        out = []
        for r in self._db.execute(
            "SELECT prefix_hash, COUNT(*) n, AVG(prefix_tokens) ptok, "
            "AVG(in_tokens) intok, AVG(baseline_cost) bc, served_model "
            "FROM events WHERE prefix_tokens >= ? AND prefix_hash IS NOT NULL "
            "GROUP BY prefix_hash HAVING n > 1 ORDER BY n DESC LIMIT 20",
                (MIN_CACHEABLE_PREFIX_TOKENS,)):
            reuse = r["n"] - 1  # first call warms the cache; the rest read it
            # cached input bills at CACHE_READ_FACTOR of the served model's input
            # price; saved ≈ reuse × prefix_tokens × in_price × (1 − factor).
            ptok = r["ptok"] or 0
            m = reg.get(r["served_model"])
            in_price = m.in_price if m else 0.0
            saved = reuse * ptok * in_price * (1 - CACHE_READ_FACTOR) / 1_000_000
            out.append({
                "kind": "prompt-cache",
                "prefix_hash": r["prefix_hash"],
                "prefix_tokens": round(ptok),
                "reuses": reuse,
                "occurrences": r["n"],
                "quality_impact": 0.0,
                "savings": round(saved, 6),
                "measured": True,
                "detail": (f"a ~{int(ptok)}-token prefix repeats {r['n']}× — enable "
                           f"prompt caching to bill {reuse} reuse(s) at "
                           f"{int(CACHE_READ_FACTOR * 100)}% input price"),
            })
        return out

    def response_cache_opportunities(self) -> list[dict]:
        out = []
        for r in self._db.execute(
            "SELECT request_key, COUNT(*) n, AVG(baseline_cost) bc, task_class "
            "FROM events WHERE deterministic = 1 AND request_key IS NOT NULL "
            "GROUP BY request_key HAVING n > 1 ORDER BY n DESC LIMIT 20"):
            repeats = r["n"] - 1
            out.append({
                "kind": "response-cache",
                "request_key": r["request_key"],
                "task_class": r["task_class"],
                "repeats": repeats,
                "quality_impact": 0.0,
                "savings": round(repeats * (r["bc"] or 0.0), 6),
                "measured": True,
                "detail": (f"identical deterministic request seen {r['n']}× — "
                           f"response cache serves {repeats} at $0"),
            })
        return out

    def opportunities(self, reg, cfg) -> list[dict]:
        ops = (self.route_opportunities(cfg)
               + self.response_cache_opportunities()
               + self.prompt_cache_opportunities(reg))
        ops.sort(key=lambda o: o["savings"], reverse=True)
        return ops
