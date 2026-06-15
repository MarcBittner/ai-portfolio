from routelens.classify import Features
from routelens.quality import heuristics, judge
from routelens.registry import DEFAULT as REG


def _f(task="chat", **kw):
    base = dict(task_class=task, approx_in_tokens=50, n_messages=1, max_tokens=400,
                wants_json=False, has_code=False, system_tokens=0, multiturn=False)
    base.update(kw)
    return Features(**base)


def test_identical_scores_high():
    c = heuristics("Paris is the capital.", "Paris is the capital.", _f())
    assert sum(c.values()) / len(c) > 0.95


def test_refusal_mismatch_penalised():
    c = heuristics("Paris.", "I cannot help with that.", _f())
    assert c["refusal_agree"] == 0.0


def test_json_key_mismatch_penalised():
    c = heuristics('{"a":1,"b":2}', '{"a":1}', _f("extraction", wants_json=True))
    assert c["json"] < 1.0


def test_judge_returns_none_without_real_pair():
    # no candidate text -> nothing real to measure -> None (never fabricated)
    assert judge("baseline", "", _f(), reg=REG, use_llm=False) is None


def test_heuristics_only_when_no_judge(monkeypatch):
    import routelens.quality as q
    monkeypatch.setattr(q, "pick_judge", lambda reg: None)
    score = judge("Paris.", "Paris.", _f(), reg=REG)
    assert score is not None
    assert score.method == "heuristics"
    assert score.judge_score is None
    assert score.retained > 0.9
