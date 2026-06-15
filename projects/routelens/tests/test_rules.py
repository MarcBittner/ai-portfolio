from routelens.classify import classify
from routelens.registry import DEFAULT as REG
from routelens.rules import RouteConfig, Rule, Ruleset, generate_rules


def _stat(task, cand, retained, saved, n=10):
    return dict(task_class=task, baseline_model="opus", candidate_model=cand,
                n=n, retained=retained, saved_per_req=saved, avg_in=100,
                avg_out=100, confidence=0.5)


def test_floor_is_a_hard_gate():
    cfg = RouteConfig(floor=0.9, min_samples=3)
    rules = generate_rules([_stat("extraction", "B", 0.70, 0.05)], REG, cfg)
    assert rules == []  # below floor → never routed, even though it saves more


def test_rate_tiebreak_among_floor_clearers():
    cfg = RouteConfig(floor=0.9, rate=0.5, min_samples=3)
    stats = [_stat("chat", "cheap_lowq", 0.91, 0.012),
             _stat("chat", "pricey_hiq", 0.99, 0.011)]
    # value = saved - rate*(1-retained): cheap=0.012-0.045=-0.033;
    # hiq=0.011-0.005=0.006 -> hiq wins
    rules = generate_rules(stats, REG, cfg)
    assert len(rules) == 1 and rules[0].route_to == "pricey_hiq"


def test_min_samples_required():
    cfg = RouteConfig(floor=0.9, min_samples=5)
    assert generate_rules([_stat("chat", "A", 0.99, 0.01, n=2)], REG, cfg) == []


def test_rule_matches_task_and_size():
    r = Rule(id="r", route_to="local", match={"task_class": "chat",
                                              "max_in_tokens": 50})
    small = classify([{"role": "user", "content": "hi"}])
    assert r.matches(small)
    big = classify([{"role": "user", "content": "word " * 200}])
    assert not r.matches(big)  # exceeds max_in_tokens


def test_ruleset_first_match_wins():
    rs = Ruleset([Rule(id="a", route_to="x", match={"task_class": "chat"}),
                  Rule(id="b", route_to="y", match={"task_class": "chat"})])
    assert rs.match(classify([{"role": "user", "content": "hi"}])).id == "a"
