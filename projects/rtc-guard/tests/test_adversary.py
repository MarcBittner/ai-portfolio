from rtc_guard.adversary import run


def test_every_attack_is_blocked():
    r = run()
    assert r["total"] == 8
    assert r["blocked"] == r["total"]
    assert r["block_rate"] == 1.0
    for c in r["checks"]:
        assert c["blocked"] is True, f"{c['attack']} leaked: {c['detail']}"


def test_specific_attacks_present():
    attacks = {c["attack"] for c in run()["checks"]}
    assert any("escalate" in a for a in attacks)
    assert any("replay" in a for a in attacks)
    assert any("alg=none" in a for a in attacks)
