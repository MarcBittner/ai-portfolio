"""Offline demo: mint a scoped token, verify it, then run the adversarial suite
and summarize the threat model.

Run: python -m rtc_guard.demo   (no network required)
"""

from rtc_guard import adversary, token
from rtc_guard.threat_model import threat_model


def main() -> None:
    tok = token.mint("alice", "room-a", "publisher", ttl=300)
    v = token.verify(tok, expected_room="room-a")
    grant = v["claims"]["video"]
    print("Minted a 'publisher' token for alice @ room-a:")
    print(f"   valid={v['valid']}  canPublish={grant['canPublish']} "
          f"canSubscribe={grant['canSubscribe']}  exp in 300s\n")

    print("Adversarial suite (every attack must be blocked):")
    r = adversary.run()
    for c in r["checks"]:
        mark = "BLOCKED" if c["blocked"] else "LEAK!! "
        print(f"   [{mark}] {c['attack']:<34} {c['detail']}")
    print(f"\n   → {r['blocked']}/{r['total']} blocked ({r['block_rate']*100:.0f}%)")

    tm = threat_model()
    print(f"\nThreat model: {tm['count']} threats across "
          f"{', '.join(tm['by_category'])}.")


if __name__ == "__main__":
    main()
