from rtc_guard import token as tk


def test_mint_and_verify_roundtrip():
    t = tk.mint("alice", "room-a", "publisher", ttl=300, now=1000)
    v = tk.verify(t, expected_room="room-a", now=1010)
    assert v["valid"] is True
    assert v["claims"]["sub"] == "alice"
    assert tk.can(v["claims"], "canPublish") is True


def test_least_privilege_viewer_cannot_publish():
    claims = tk.decode(tk.mint("bob", "room-a", "viewer", now=1000))
    assert tk.can(claims, "canSubscribe") is True
    assert tk.can(claims, "canPublish") is False


def test_expired_token_rejected():
    t = tk.mint("alice", "room-a", ttl=300, now=1000)
    assert tk.verify(t, now=2000)["valid"] is False


def test_nbf_in_future_rejected():
    t = tk.mint("alice", "room-a", ttl=300, now=5000)
    assert tk.verify(t, now=1000)["valid"] is False


def test_room_scope_enforced():
    t = tk.mint("alice", "room-a", now=1000)
    assert tk.verify(t, expected_room="room-b", now=1010)["valid"] is False


def test_bad_signature_rejected():
    t = tk.mint("alice", "room-a", now=1000)
    forged = tk.encode(tk.decode(t), key="attacker-key")
    assert tk.verify(forged, now=1010)["valid"] is False


def test_single_use_replay_rejected():
    seen: set = set()
    t = tk.mint("alice", "room-a", now=1000)
    assert tk.verify(t, now=1010, jti_store=seen)["valid"] is True
    assert tk.verify(t, now=1020, jti_store=seen)["valid"] is False


def test_unknown_template_raises():
    try:
        tk.mint("alice", "room-a", "superuser")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
