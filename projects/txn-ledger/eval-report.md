# txn-ledger — eval report

Reproducible with `./run.sh eval`. Offline (deterministic plan capture + a canned NL→SQL matcher) by default, so these numbers reproduce exactly with zero keys; set provider keys or `LLM_MODE` to score a live model.

## Query-plan regression (the hot path)

The cardinal infra invariant: the per-committee rollup must still resolve through the covering index after tuning — a query that quietly reverts to a full table **SCAN** is the classic cause of a latency blow-up under a filing-deadline read surge, so this is pass/fail, not a soft metric.

| check | result |
| --- | --- |
| full SCAN before the index | True |
| SEARCH via INDEX after the index | True |
| covering (no heap lookups) | True |
| no SCAN after the index | True |
| **regression passed** | **True** |

```
-- BEFORE (no index)
SCAN contributions
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR count(DISTINCT)
USE TEMP B-TREE FOR ORDER BY

-- AFTER (idx_cycle_committee)
SEARCH contributions USING COVERING INDEX idx_cycle_committee (cycle=?)
USE TEMP B-TREE FOR count(DISTINCT)
USE TEMP B-TREE FOR ORDER BY
```

## Natural-language → SQL accuracy

Scored over **8** labeled plain-English questions. Each is translated to SQL through the routing chain, the generated SQL is guarded to a single read-only SELECT, executed, and the rows compared to the expected answer computed directly from the store. **Safety is the gate** — an unsafe (non-SELECT / multi-statement / DDL) translation is never run.

| metric | value |
| --- | --- |
| questions | 8 |
| passed the SQL safety guard | 8 |
| correct answer | 8 |
| accuracy | 1.0 |
| providers used | offline |

| question | safe | correct | generated SQL |
| --- | --- | --- | --- |
| total raised in the 2024 cycle | True | True | `SELECT SUM(amount) AS total_raised FROM contributions WHERE cycle = 2024` |
| total raised overall | True | True | `SELECT SUM(amount) AS total_raised FROM contributions` |
| top 5 committees by itemized total in 2024 | True | True | `SELECT committee_id, SUM(CASE WHEN amount > 200 THEN amount ELSE 0 END) AS itemized FROM contributions WHERE cycle = 2024 GROUP BY committee_id ORDER BY itemized DESC LIMIT 5` |
| top 3 committees by total raised in 2026 | True | True | `SELECT committee_id, SUM(amount) AS total_raised FROM contributions WHERE cycle = 2026 GROUP BY committee_id ORDER BY total_raised DESC LIMIT 3` |
| how many donors gave under 200 in 2026 | True | True | `SELECT COUNT(DISTINCT donor_id) AS donors FROM contributions WHERE cycle = 2026 AND amount < 200` |
| how many contributions in the 2022 cycle | True | True | `SELECT COUNT(*) AS contributions FROM contributions WHERE cycle = 2022` |
| itemized vs unitemized total in 2024 | True | True | `SELECT SUM(CASE WHEN amount > 200 THEN amount ELSE 0 END) AS itemized, SUM(CASE WHEN amount <= 200 THEN amount ELSE 0 END) AS unitemized FROM contributions WHERE cycle = 2024` |
| how many distinct donors overall | True | True | `SELECT COUNT(DISTINCT donor_id) AS donors FROM contributions` |

> The offline matcher maps a handful of question patterns to prebuilt parameterized queries, so it is exact on the labeled set and the eval reproduces with zero keys. The LLM path is what generalizes to phrasings the matcher never saw — and the **safety guard is identical on either route**: model output is parsed and rejected unless it is one read-only SELECT, then run against a `query_only` connection.
